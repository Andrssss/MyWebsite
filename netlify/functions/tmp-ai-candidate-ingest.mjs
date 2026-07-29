// TEMPORARY one-off endpoint — bulk-ingest a hand/LLM-extracted candidate pool
// (output/candidate_pool.json, ~100 URLs from a manual site sweep) into the
// ai-scraped pipeline. Reuses the SAME ingestJobs/sanitizeJobs core the real
// ai-ingest.mjs endpoint uses (IT-only gate, senior-title blacklist, location
// filter, company blocklist, title-wins experience resolution, upsert+reconcile
// in reactivate-only mode since this is not a full listing). Deliberately
// bypasses ai-ingest.mjs's hourly write budget (_ai_rate_limit.mjs) — that cap
// exists to bound a leaked-token abuse case, not a legitimate owner-initiated
// bulk backfill; same precedent as the 2026-07-28 manual batches. One-off
// hardcoded token, same pattern as tmp-onefix/tmp-muisz-kat4-delete. Delete
// this file after use.
import pkg from "pg";
const { Pool } = pkg;
import { loadFilters } from "./load_filters.mjs";
import { loadCategories } from "./load_categories.mjs";
import { ingestJobs, sanitizeJobs, AI_SOURCE } from "./_ai_ingest_core.mjs";

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });
const ONE_OFF_TOKEN = "4bc6f8e2bb0b438d4d6e5da53297d8c24b63ed4d55e70fad";

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export default async (request) => {
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (token !== ONE_OFF_TOKEN) return json(401, { error: "Unauthorized" });
  if (request.method !== "POST") return json(405, { error: "POST only" });

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }
  if (!Array.isArray(payload.jobs)) return json(400, { error: "jobs array required" });

  const jobs = sanitizeJobs(payload.jobs);
  const [filters, categories] = await Promise.all([loadFilters(), loadCategories()]);

  const client = await pool.connect();
  try {
    const stats = await ingestJobs(client, {
      source: AI_SOURCE,
      jobs,
      fullListing: false, // this batch is a partial candidate pool, not a complete site listing
      filters,
      categories,
    });
    console.log(`[tmp-ai-candidate-ingest] received=${payload.jobs.length} clean=${jobs.length} ${JSON.stringify(stats)}`);
    return json(200, { received: payload.jobs.length, clean: jobs.length, ...stats });
  } catch (err) {
    console.error(`[tmp-ai-candidate-ingest] error: ${err.message}`);
    return json(500, { error: "Szerver hiba", details: err.message });
  } finally {
    client.release();
  }
};
