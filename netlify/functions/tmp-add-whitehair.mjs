// DISPOSABLE — one-off manual ingest of a single AI-scraped posting that was
// wrongly skipped by the location backstop (bare street address with no
// "Budapest" word). See _ai_ingest_core.mjs isNonBudapestLocation. Delete
// this file right after the one invocation that confirms the row landed.
//
// curl -X POST https://bakan7.netlify.app/.netlify/functions/tmp-add-whitehair \
//   -H "Authorization: Bearer b7bd66d630450e0e33669452678019f33e5d37ef6a758035"

import { Pool } from "pg";
import { loadFilters } from "./load_filters.mjs";
import { loadCategories } from "./load_categories.mjs";
import { ingestJobs, sanitizeJobs, AI_SOURCE } from "./_ai_ingest_core.mjs";

const TOKEN = "b7bd66d630450e0e33669452678019f33e5d37ef6a758035";

const connectionString = process.env.NETLIFY_DATABASE_URL;
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export default async (request) => {
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (token !== TOKEN) return json(401, { error: "Unauthorized" });

  const jobs = sanitizeJobs([{
    title: "Front-end fejlesztő",
    url: "https://whitehair.hu/allasajanlatok/frontend",
    company: "White Hair",
    location: "Budapest, XI. kerület, Nádorliget utca 7/a",
    technologies: "JavaScript, HTML, CSS, Ajax",
  }]);

  const [filters, categories] = await Promise.all([loadFilters(), loadCategories()]);
  const client = await pool.connect();
  try {
    const stats = await ingestJobs(client, {
      source: AI_SOURCE,
      jobs,
      fullListing: false,
      filters,
      categories,
      handoffAtsUrls: true,
      skipCrossSourceDupes: true,
    });
    return json(200, stats);
  } catch (err) {
    return json(500, { error: err.message });
  } finally {
    client.release();
  }
};
