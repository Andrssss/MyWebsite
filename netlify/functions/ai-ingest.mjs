// netlify/functions/ai-ingest.mjs
//
// Authenticated write path for the `ai-scraped` pipeline. Accepts a batch of
// already-extracted job rows for one site and runs them through the SAME
// filter + url-keyed upsert + reconcile as the automated worker
// (_ai_ingest_core.mjs), writing to source `AI - <site>`.
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
import { ingestJobs, sanitizeJobs, toSlug } from "./_ai_ingest_core.mjs";

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export default async (request) => {
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

  const jobs = sanitizeJobs(payload.jobs);
  const source = `AI - ${slug}`;

  const [filters, categories] = await Promise.all([loadFilters(), loadCategories()]);
  const client = await pool.connect();
  try {
    const stats = await ingestJobs(client, {
      source,
      jobs,
      fullListing: payload.full_listing === true,
      filters,
      categories,
    });
    console.log(`[ai-ingest ${source}] received=${payload.jobs.length} clean=${jobs.length} ${JSON.stringify(stats)}`);
    return json(200, { source, received: payload.jobs.length, ...stats });
  } catch (err) {
    console.error(`[ai-ingest ${source}] error: ${err.message}`);
    return json(500, { error: "Szerver hiba", details: err.message });
  } finally {
    client.release();
  }
};
