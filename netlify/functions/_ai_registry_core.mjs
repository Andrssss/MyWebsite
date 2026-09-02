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
import { normTitle, normCompany } from "./_ai_dupe_guard.mjs";

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

// Lets the discovery routine skip a detail-page fetch for a posting some
// OTHER scraper (hand-written or AI, any source) already has live, instead of
// learning that only after paying for the fetch AND the reasoning to decide
// what to submit — the server-side reject (_ai_dupe_guard.mjs) runs too late
// to save either. Same normTitle/normCompany the cross-source dupe guard uses,
// so a (company, title) pair listed here is exactly one that guard would drop
// on submission anyway. Deliberately covers EVERY source, not just non-AI
// ones (unlike _ai_dupe_guard's own `source <> $1`), so two AI-discovered
// companies that turn out to post the same requisition also show up here —
// that guard only ever compares an AI candidate against OTHER sources.
async function getActiveTitlesByCompany() {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT title, company FROM job_posts
        WHERE active = TRUE AND company IS NOT NULL AND btrim(company) <> ''`
    );
    const byCompany = new Map();
    for (const r of rows) {
      const c = normCompany(r.company);
      const t = normTitle(r.title);
      if (!c || !t) continue;
      if (!byCompany.has(c)) byCompany.set(c, new Set());
      byCompany.get(c).add(t);
    }
    const out = {};
    for (const [c, titles] of byCompany) out[c] = [...titles];
    return out;
  } finally {
    client.release();
  }
}

export async function getRegistrySnapshot() {
  const reg = await readRegistry();
  const budget = await checkBudget();
  const activeTitlesByCompany = await getActiveTitlesByCompany();
  return {
    sites: reg.sites,
    permanentlyRejected: reg.permanentlyRejected,
    knownUrls: reg.findings.map((f) => f.url).filter(Boolean),
    // Keyed by normCompany() — look up a candidate company the same way
    // _ai_dupe_guard.mjs does before spending a detail-page fetch on it.
    activeTitlesByCompany,
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
      // ATS-átadás: egy ATS-boardra mutató találatból tenant lesz, nem job_posts
      // sor (_ats_handoff.mjs). Ugyanaz a szabály, mint az ai-ingest.mjs-ben és a
      // cron_jobs_AI-background.mjs-ben — ez a harmadik (és a felderítő rutin
      // TÉNYLEGES) belépési pontja, 2026-09-01-ig tévedésből kimaradt innen,
      // ezért a rutin ATS-találatai továbbra is duplikált AI-scraped sorként
      // mentek be.
      const stats = await ingestJobs(client, {
        source: AI_SOURCE, jobs: allJobs, fullListing: false, filters, categories,
        handoffAtsUrls: true,
        // Amit már egy másik forrás behozott, azt nem duplázzuk (_ai_dupe_guard.mjs).
        skipCrossSourceDupes: true,
      });
      results[AI_SOURCE] = stats;
      totalWritten = stats.insertedUrls.length;
      console.log(
        `[ai-registry-core] ${AI_SOURCE}: rows=${stats.rows} inserted=${stats.inserted} ` +
        `skip_senior=${stats.skippedSenior} skip_company=${stats.skippedCompany} ` +
        `skip_non_it=${stats.skippedNonIt} skip_location=${stats.skippedLocation} ` +
        `ats_handoff=${stats.handedToAts} ats_legacy=${stats.skippedLegacyAts} ` +
        `ats_tenants_added=${JSON.stringify(stats.atsTenantsAdded)} ` +
        `dupe_skipped=${stats.skippedDuplicate} ${JSON.stringify(stats.duplicateOf)}`
      );

      const insertedSet = new Set(stats.insertedUrls);
      // Az ATS-nek átadott url-ek is "ismertnek" számítanak: sor nem lett
      // belőlük, de a rutin `knownUrls` listája ebből épül, és enélkül minden
      // futásban újra beküldené ugyanazt a boardot.
      const handedSet = new Set(stats.handedToAtsUrls || []);
      // Ugyanez a logika a kereszt-forrás duplikátumokra: sor nem lett belőlük,
      // de ha nem jegyeznénk fel, a rutin minden futásban újra beküldené őket.
      const dupeSet = new Set(stats.skippedDuplicateUrls || []);
      const known = new Set(reg.findings.map((f) => f.url));
      for (const j of allJobs) {
        if (known.has(j.url)) continue;
        if (insertedSet.has(j.url)) {
          reg.findings.push({ slug: slugByUrl.get(j.url), ...j, foundDate: now });
        } else if (handedSet.has(j.url)) {
          reg.findings.push({ slug: slugByUrl.get(j.url), ...j, foundDate: now, handedToAts: true });
        } else if (dupeSet.has(j.url)) {
          reg.findings.push({ slug: slugByUrl.get(j.url), ...j, foundDate: now, duplicateOfOtherSource: true });
        }
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
