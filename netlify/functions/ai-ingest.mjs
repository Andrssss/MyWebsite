// netlify/functions/ai-ingest.mjs
//
// Authenticated write path for the `ai-scraped` pipeline. Accepts a batch of
// already-extracted job rows for one site and runs them through the SAME
// filter + url-keyed upsert + reconcile as the automated worker
// (_ai_ingest_core.mjs), writing to source `ai:<site>`.
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
import { ingestJobs } from "./_ai_ingest_core.mjs";

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

const TRACKING = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid"];

function toSlug(s) {
  return String(s || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function normalizeUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    TRACKING.forEach((p) => u.searchParams.delete(p));
    return u.toString().replace(/\?$/, "");
  } catch {
    return null;
  }
}

// Normalize + dedupe caller-supplied rows (no HTML hallucination guard here —
// the caller is trusted via CRON_SECRET; the guard lives in _ai_extract_core for LLM output).
function sanitize(rawJobs) {
  const seen = new Set();
  const out = [];
  for (const j of rawJobs || []) {
    if (!j || typeof j.title !== "string" || typeof j.url !== "string") continue;
    const title = j.title.replace(/\s+/g, " ").trim();
    const url = normalizeUrl(j.url.trim());
    if (title.length < 3 || !url || seen.has(url)) continue;
    seen.add(url);
    out.push({
      title: title.slice(0, 300),
      url,
      company: j.company ? String(j.company).replace(/\s+/g, " ").trim().slice(0, 200) || null : null,
      location: j.location ? String(j.location).replace(/\s+/g, " ").trim().slice(0, 200) || null : null,
      experience: j.experience ? String(j.experience).replace(/\s+/g, " ").trim().slice(0, 100) || null : null,
      technologies: j.technologies ? String(j.technologies).replace(/\s+/g, " ").trim().slice(0, 500) || null : null,
    });
  }
  return out;
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export default async (request) => {
  // Auth (writes to prod DB).
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!process.env.CRON_SECRET || token !== process.env.CRON_SECRET) {
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

  const jobs = sanitize(payload.jobs);
  const source = `ai:${slug}`;

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
