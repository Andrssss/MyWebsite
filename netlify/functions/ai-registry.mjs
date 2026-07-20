// netlify/functions/ai-registry.mjs
//
// The single API the AI-scraped discovery ROUTINE talks to. Replaces the old
// "routine writes ai_scraped_registry.json and git-pushes it" design, which
// never actually worked — the push silently failed on every run since
// 2026-07-17, so not one finding ever reached the DB (see AI_SCRAPER_PLAN.md §0).
//
// Two halves, because the routine needs BOTH:
//
//   GET  → the routine's MEMORY. Routines start cold every run
//          (persist_session:false), so without this it would re-research the
//          same ~120 already-rejected companies forever. Returns the sites it
//          has checked (with lastChecked, for the 7-day re-check rule), the
//          permanently-rejected list, and the urls it has already found.
//
//   POST → the routine's WRITE. Findings go through the exact same
//          filter/upsert/reconcile tail every other AI-scraped write path uses
//          (_ai_ingest_core.mjs ingestJobs) — so the routine's own LLM judgment
//          is never the only gate; isItJob/isSeniorLike/isSeniorByYears and the
//          company blocklist all re-apply here, deterministically, in code.
//
// The POST is INCREMENTAL, not a whole-state replace: the routine reports only
// what it did this run ({findings, sitesChecked, rejected}) and the server
// merges into stored state. That keeps payloads small no matter how big the
// registry grows, and means a run that dies halfway can't truncate the state it
// never got around to echoing back.
//
// State lives in Netlify Blobs (same store pattern as fetch-error-logs /
// weekly-backups) rather than Postgres — it's one small JSON doc of bookkeeping,
// not relational data, and this avoids a schema migration for it.
//
//   curl https://bakan7.netlify.app/.netlify/functions/ai-registry \
//     -H "Authorization: Bearer $AI_INGEST_TOKEN"
//
//   curl -X POST https://bakan7.netlify.app/.netlify/functions/ai-registry \
//     -H "Authorization: Bearer $AI_INGEST_TOKEN" -H "Content-Type: application/json" \
//     -d '{"findings":[{"slug":"example","title":"Junior Dev","url":"https://example.hu/allas/1",
//          "company":"ACME","experience":"junior","technologies":"Java"}],
//          "sitesChecked":{"example":{"url":"https://example.hu/karrier","status":"has_junior_opening"}},
//          "rejected":["SomeCorp"]}'

import { Pool } from "pg";
import { getStore } from "@netlify/blobs";
import { loadFilters } from "./load_filters.mjs";
import { loadCategories } from "./load_categories.mjs";
import { ingestJobs, sanitizeJobs, toSlug } from "./_ai_ingest_core.mjs";
import { checkBudget, consume, tooManyRequests, MAX_ROWS_PER_REQUEST } from "./_ai_rate_limit.mjs";

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

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

// Accepts a token dedicated to this endpoint, falling back to CRON_SECRET so
// the function still works before AI_INGEST_TOKEN is set. AI_INGEST_TOKEN is
// the one to actually use: it has to live in the routine's stored prompt text
// (routines have no env-var injection), and a token that can only reach this
// one filtered endpoint is a far smaller blast radius than CRON_SECRET, which
// authorizes every background worker in the cron fleet.
function authorized(request) {
  const expected = process.env.AI_INGEST_TOKEN || process.env.CRON_SECRET;
  if (!expected) return false;
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  return token === expected;
}

// Deploy-time diagnostic for the 401 body. Reports only WHICH env var the
// function is comparing against and whether a token was sent at all — never any
// part of either secret. Without this, "var not set", "var has a typo", and
// "var set but Netlify hasn't redeployed yet" are indistinguishable from
// outside, since all three return an identical 401.
function authDiagnostic(request) {
  return {
    comparingAgainst: process.env.AI_INGEST_TOKEN ? "AI_INGEST_TOKEN"
      : process.env.CRON_SECRET ? "CRON_SECRET (fallback — AI_INGEST_TOKEN is NOT set)"
      : "nothing (neither AI_INGEST_TOKEN nor CRON_SECRET is set)",
    bearerReceived: /^Bearer\s+\S/i.test(request.headers.get("authorization") || ""),
  };
}

/* ── GET: hand the routine its memory ───────────────────────────────── */

async function handleGet() {
  const reg = await readRegistry();
  // Hand the caller its remaining upload budget so it can stop hunting for more
  // postings once it has enough to fill it — verifying finds it can't upload
  // this hour is wasted effort (they'd throttle and get re-found next run).
  const budget = await checkBudget();
  return json(200, {
    sites: reg.sites,
    permanentlyRejected: reg.permanentlyRejected,
    // urls only — the routine needs these to skip already-found postings, and
    // sending full finding objects would grow this response without bound.
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
  });
}

/* ── POST: ingest findings + merge this run's bookkeeping ───────────── */

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

async function handlePost(request) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  const submitted = Array.isArray(payload.findings) ? payload.findings : [];

  // Oversized payload: reject before any DB work rather than filtering 10k rows.
  if (submitted.length > MAX_ROWS_PER_REQUEST) {
    return json(413, {
      error: "Too many findings in one request",
      max: MAX_ROWS_PER_REQUEST,
      received: submitted.length,
    });
  }

  // Hourly write budget — caps what a leaked token can inject. The content
  // filters stop accidental bad rows but can be gamed by crafted titles; this
  // bounds the damage regardless of what the titles say.
  const budget = await checkBudget();
  if (submitted.length > 0 && budget.remaining === 0) return tooManyRequests(budget);

  // Truncate to the remaining budget so this request can't exceed it. Dropped
  // rows are NOT recorded as findings, so the routine re-finds them next run
  // rather than losing them silently.
  const throttled = Math.max(0, submitted.length - budget.remaining);
  const accepted = submitted.slice(0, budget.remaining);

  const reg = await readRegistry();
  const now = new Date().toISOString();
  const results = {};
  let totalWritten = 0;

  // 1. Findings → the real DB, through the shared deterministic gates.
  const groups = groupBySlug(accepted);
  if (groups.size > 0) {
    const [filters, categories] = await Promise.all([loadFilters(), loadCategories()]);
    const client = await pool.connect();
    try {
      for (const [slug, rawJobs] of groups) {
        const source = `AI - ${slug}`;
        const jobs = sanitizeJobs(rawJobs);
        // fullListing:false — the routine reports individual postings it found,
        // never a site's complete current listing, so reconcile stays
        // reactivate-only and the 404 sweep owns deaths (same as every other
        // AI-scraped write path).
        const stats = await ingestJobs(client, { source, jobs, fullListing: false, filters, categories });
        results[source] = stats;
        totalWritten += stats.insertedUrls.length;
        console.log(
          `[ai-registry] ${source}: rows=${stats.rows} inserted=${stats.inserted} ` +
          `skip_senior=${stats.skippedSenior} skip_company=${stats.skippedCompany} ` +
          `skip_non_it=${stats.skippedNonIt}`
        );

        // Record only what actually survived the gates, so the routine's
        // knownUrls reflects the DB rather than what it hoped to write.
        const accepted = new Set(stats.insertedUrls);
        const known = new Set(reg.findings.map((f) => f.url));
        for (const j of jobs) {
          if (!accepted.has(j.url) || known.has(j.url)) continue;
          reg.findings.push({ slug, ...j, foundDate: now });
        }
      }
    } finally {
      client.release();
    }
  }

  // 2. Merge this run's bookkeeping.
  for (const [rawSlug, info] of Object.entries(payload.sitesChecked || {})) {
    const slug = toSlug(rawSlug);
    if (!slug) continue;
    reg.sites[slug] = {
      ...(reg.sites[slug] || {}),
      ...(info && typeof info === "object" ? info : {}),
      lastChecked: now,
    };
  }

  const rejectedSet = new Set(reg.permanentlyRejected);
  for (const name of payload.rejected || []) {
    const n = String(name || "").trim();
    if (n) rejectedSet.add(n);
  }
  reg.permanentlyRejected = [...rejectedSet];

  await writeRegistry(reg);

  // Charge only rows that actually reached the DB — rows the content filters
  // dropped never got written, so billing them would let a legitimate run with
  // a few rejects starve its own budget.
  await consume(totalWritten);

  return json(200, {
    ok: true,
    ingested: results,
    rateLimit: {
      limit: budget.limit,
      writtenThisRequest: totalWritten,
      remainingBefore: budget.remaining,
      throttled, // submitted but not processed — re-submit next run
      resetInSeconds: budget.resetInSeconds,
    },
    counts: {
      sites: Object.keys(reg.sites).length,
      permanentlyRejected: reg.permanentlyRejected.length,
      findings: reg.findings.length,
    },
  });
}

export default async (request) => {
  if (!authorized(request)) return json(401, { error: "Unauthorized", ...authDiagnostic(request) });
  if (request.method === "GET") return handleGet();
  if (request.method === "POST") return handlePost(request);
  return json(405, { error: "GET or POST only" });
};
