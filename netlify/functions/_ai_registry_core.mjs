// netlify/functions/_ai_registry_core.mjs
//
// The registry GET/POST logic, extracted out of ai-registry.mjs so it has
// exactly one implementation reachable from two transports:
//
//   ai-registry.mjs  — the existing REST endpoint (Authorization: Bearer
//                       header over plain HTTP). Unchanged behavior.
//   ai-mcp.mjs        — an MCP tool-call endpoint for the same operations,
//                       added so the discovery routine's orchestrator can
//                       fetch/submit without ever composing a raw
//                       `curl -H "Authorization: Bearer $TOKEN"` command
//                       itself (see ai-mcp.mjs header for why that matters).
//
// Splitting this out is NOT a rewrite: every line below is the same
// read-modify-write, the same budget/filter/upsert tail, the same registry
// shape. Only the Response-wrapping and the per-transport auth check stayed
// behind in ai-registry.mjs.

import { Pool } from "pg";
import { getStore } from "@netlify/blobs";
import { loadFilters } from "./load_filters.mjs";
import { loadCategories } from "./load_categories.mjs";
import { ingestJobs, sanitizeJobs, toSlug, AI_SOURCE } from "./_ai_ingest_core.mjs";
import { checkBudget, consume, MAX_ROWS_PER_REQUEST } from "./_ai_rate_limit.mjs";

// Same module-level pool pattern as every other function here (ai-ingest.mjs,
// the old ai-registry.mjs) — created once per warm container, connect/release
// per request, never torn down. Both transports (ai-registry.mjs, ai-mcp.mjs)
// import this module, so there is still exactly one pool for this logic no
// matter which one a given request came in through.
const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

const STORE_NAME = "ai-scraped-registry";
const KEY = "registry.json";

const EMPTY = { sites: {}, permanentlyRejected: [], findings: [], updatedAt: null };

// Strong consistency: this is a read-modify-write of a single doc, and the
// routine's next run must see what this run just committed.
function store() {
  return getStore({ name: STORE_NAME, consistency: "strong" });
}

async function readRegistry() {
  const raw = await store().get(KEY, { type: "json" });
  if (!raw || typeof raw !== "object") return { ...EMPTY };
  return {
    sites: raw.sites && typeof raw.sites === "object" ? raw.sites : {},
    permanentlyRejected: Array.isArray(raw.permanentlyRejected) ? raw.permanentlyRejected : [],
    findings: Array.isArray(raw.findings) ? raw.findings : [],
    updatedAt: raw.updatedAt || null,
  };
}

async function writeRegistry(reg) {
  await store().setJSON(KEY, { ...reg, updatedAt: new Date().toISOString() });
}

function groupBySlug(findings) {
  const groups = new Map();
  for (const f of findings || []) {
    if (!f || !f.title || !f.url) continue;
    const slug = toSlug(f.slug);
    if (!slug) continue;
    if (!groups.has(slug)) groups.set(slug, []);
    groups.get(slug).push(f);
  }
  return groups;
}

/* ── GET: hand the routine its memory ───────────────────────────────── */

export async function getRegistrySnapshot() {
  const reg = await readRegistry();
  const budget = await checkBudget();
  return {
    sites: reg.sites,
    permanentlyRejected: reg.permanentlyRejected,
    knownUrls: reg.findings.map((f) => f.url).filter(Boolean),
    uploadBudget: {
      remaining: budget.remaining,
      limit: budget.limit,
      resetInSeconds: budget.resetInSeconds,
    },
    counts: {
      sites: Object.keys(reg.sites).length,
      permanentlyRejected: reg.permanentlyRejected.length,
      findings: reg.findings.length,
    },
    updatedAt: reg.updatedAt,
  };
}

/* ── POST: ingest findings + merge this run's bookkeeping ───────────── */

// Thrown for conditions the two transports need to render as their own
// native error shape (413 / 429 over REST, a JSON-RPC error over MCP)
// instead of a generic 500.
export class RegistryRequestError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code; // "too_many_rows" | "rate_limited"
    this.details = details;
  }
}

export async function submitFindings(payload) {
  const submitted = Array.isArray(payload?.findings) ? payload.findings : [];

  if (submitted.length > MAX_ROWS_PER_REQUEST) {
    throw new RegistryRequestError("too_many_rows", "Too many findings in one request", {
      max: MAX_ROWS_PER_REQUEST,
      received: submitted.length,
    });
  }

  const budget = await checkBudget();
  if (submitted.length > 0 && budget.remaining === 0) {
    throw new RegistryRequestError("rate_limited", "Rate limit exceeded", {
      limit: budget.limit,
      remaining: 0,
      retryAfterSeconds: budget.resetInSeconds,
      hint: `The ai-scraped write budget is ${budget.limit} rows/hour across all endpoints.`,
    });
  }

  // Truncate to the remaining budget so this request can't exceed it. Dropped
  // rows are NOT recorded as findings, so the routine re-finds them next run
  // rather than losing them silently.
  const throttled = Math.max(0, submitted.length - budget.remaining);
  const accepted = submitted.slice(0, budget.remaining);

  const reg = await readRegistry();
  const now = new Date().toISOString();
  const results = {};
  let totalWritten = 0;

  const slugByUrl = new Map();
  const allJobs = [];
  for (const [slug, rawJobs] of groupBySlug(accepted)) {
    for (const j of sanitizeJobs(rawJobs)) {
      if (slugByUrl.has(j.url)) continue;
      slugByUrl.set(j.url, slug);
      allJobs.push(j);
    }
  }

  if (allJobs.length > 0) {
    const client = await pool.connect();
    try {
      const [filters, categories] = await Promise.all([loadFilters(), loadCategories()]);
      const stats = await ingestJobs(client, { source: AI_SOURCE, jobs: allJobs, fullListing: false, filters, categories });
      results[AI_SOURCE] = stats;
      totalWritten = stats.insertedUrls.length;
      console.log(
        `[ai-registry-core] ${AI_SOURCE}: rows=${stats.rows} inserted=${stats.inserted} ` +
        `skip_senior=${stats.skippedSenior} skip_company=${stats.skippedCompany} ` +
        `skip_non_it=${stats.skippedNonIt} skip_location=${stats.skippedLocation}`
      );

      const insertedSet = new Set(stats.insertedUrls);
      const known = new Set(reg.findings.map((f) => f.url));
      for (const j of allJobs) {
        if (!insertedSet.has(j.url) || known.has(j.url)) continue;
        reg.findings.push({ slug: slugByUrl.get(j.url), ...j, foundDate: now });
      }
    } finally {
      client.release();
    }
  }

  for (const [rawSlug, info] of Object.entries(payload?.sitesChecked || {})) {
    const slug = toSlug(rawSlug);
    if (!slug) continue;
    reg.sites[slug] = {
      ...(reg.sites[slug] || {}),
      ...(info && typeof info === "object" ? info : {}),
      lastChecked: now,
    };
  }

  const rejectedSet = new Set(reg.permanentlyRejected);
  for (const name of payload?.rejected || []) {
    const n = String(name || "").trim();
    if (n) rejectedSet.add(n);
  }
  reg.permanentlyRejected = [...rejectedSet];

  await writeRegistry(reg);

  await consume(totalWritten);

  return {
    ok: true,
    ingested: results,
    rateLimit: {
      limit: budget.limit,
      writtenThisRequest: totalWritten,
      remainingBefore: budget.remaining,
      throttled,
      resetInSeconds: budget.resetInSeconds,
    },
    counts: {
      sites: Object.keys(reg.sites).length,
      permanentlyRejected: reg.permanentlyRejected.length,
      findings: reg.findings.length,
    },
  };
}
