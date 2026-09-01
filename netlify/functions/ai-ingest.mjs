// netlify/functions/ai-ingest.mjs
//
// Authenticated write path for the `ai-scraped` pipeline. Accepts a batch of
// already-extracted job rows for one site and runs them through the SAME
// filter + url-keyed upsert + reconcile as the automated worker
// (_ai_ingest_core.mjs), writing to source `AI - <site>`.
//
// ATS-hosted postings (ashby / greenhouse / lever / smartrecruiters / recruitee
// urls) are NOT written to job_posts here. The board behind the url is
// registered in ats_tenants instead, and the daily ats-crawl worker brings in
// the WHOLE board rather than the one posting the routine happened to see.
// Reported back as handedToAts / atsTenantsAdded; reasoning in _ats_handoff.mjs.
//
// Phase 1 use (see AI_SCRAPER_PLAN.md): jobs extracted in-session / by hand are
// POSTed here — no Anthropic API involved. Same endpoint later serves a local
// script. Gated by Authorization: Bearer $CRON_SECRET (writes to prod DB).
//
//   curl -X POST https://bakan7.netlify.app/.netlify/functions/ai-ingest \
//     -H "Authorization: Bearer $CRON_SECRET" -H "Content-Type: application/json" \
//     -d '{"site":"example","jobs":[{"title":"Junior Dev","url":"https://example.hu/allas/1",
//          "company":"ACME","location":"Budapest","experience":"3 év","technologies":"Java, Spring Boot"}]}'
//
// experience/technologies are OPTIONAL, body-derived (read the job's own detail page — same
// fetch-before-insert step every hand scraper does). Title-based classification (diákmunka/junior/
// medior) always wins when the title matches; these only fill the gap when it doesn't.

import { Pool } from "pg";
import { loadFilters } from "./load_filters.mjs";
import { loadCategories } from "./load_categories.mjs";
import { ingestJobs, sanitizeJobs, toSlug, AI_SOURCE } from "./_ai_ingest_core.mjs";
import { checkBudget, consume, tooManyRequests, MAX_ROWS_PER_REQUEST } from "./_ai_rate_limit.mjs";
import { withDbAuditFlush } from "./_db_audit.js";

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export default withDbAuditFlush("ai-ingest", async (request) => {
  // Auth (writes to prod DB). Same token pair as ai-registry.mjs — the scoped
  // AI_INGEST_TOKEN when set, else CRON_SECRET.
  const expected = process.env.AI_INGEST_TOKEN || process.env.CRON_SECRET;
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!expected || token !== expected) {
    return json(401, { error: "Unauthorized" });
  }
  if (request.method !== "POST") return json(405, { error: "POST only" });

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  const slug = toSlug(payload.site);
  if (!slug) return json(400, { error: "site (slug) kötelező." });
  if (!Array.isArray(payload.jobs)) return json(400, { error: "jobs tömb kötelező." });

  if (payload.jobs.length > MAX_ROWS_PER_REQUEST) {
    return json(413, { error: "Too many jobs in one request", max: MAX_ROWS_PER_REQUEST, received: payload.jobs.length });
  }

  // Same hourly budget as ai-registry.mjs — shared on purpose, since both
  // endpoints accept the same token and a per-endpoint limit would just move
  // the abuse to whichever one wasn't capped.
  const budget = await checkBudget();
  if (payload.jobs.length > 0 && budget.remaining === 0) return tooManyRequests(budget);

  const throttled = Math.max(0, payload.jobs.length - budget.remaining);
  const jobs = sanitizeJobs(payload.jobs).slice(0, budget.remaining);
  // Flat single source for all ai-scraped rows (slug kept only for logging).
  const source = AI_SOURCE;

  const [filters, categories] = await Promise.all([loadFilters(), loadCategories()]);
  const client = await pool.connect();
  try {
    const stats = await ingestJobs(client, {
      source,
      jobs,
      // A truncated batch is no longer the site's complete listing, so it must
      // not be allowed to deactivate rows that simply fell past the cap.
      fullListing: payload.full_listing === true && throttled === 0,
      filters,
      categories,
      // An ATS-hosted posting is not ingested here: the board behind it is
      // registered as an ats_tenants row and ats-crawl harvests it whole.
      // See _ats_handoff.mjs — this is the fix for the 55 bit-identical
      // AI-scraped / ats-crawl url duplicates measured on 2026-08-30.
      handoffAtsUrls: true,
      skipCrossSourceDupes: true,
    });
    await consume(stats.insertedUrls.length);
    console.log(`[ai-ingest ${source}] received=${payload.jobs.length} clean=${jobs.length} throttled=${throttled} handedToAts=${stats.handedToAts} atsTenantsAdded=${stats.atsTenantsAdded.length} dupeSkipped=${stats.skippedDuplicate} ${JSON.stringify(stats)}`);
    return json(200, {
      source,
      received: payload.jobs.length,
      ...stats,
      rateLimit: { limit: budget.limit, throttled, resetInSeconds: budget.resetInSeconds },
    });
  } catch (err) {
    console.error(`[ai-ingest ${source}] error: ${err.message}`);
    return json(500, { error: "Szerver hiba", details: err.message });
  } finally {
    client.release();
  }
});
