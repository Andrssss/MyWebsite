/*
  AI-scraped registry sync — the DB-write half of the ai-scraped pipeline's
  fully-automated path (see AI_SCRAPER_PLAN.md).

  The discovery/research side runs as a Claude Code cloud ROUTINE (every 5h,
  billed under the Claude subscription, not a separate API key) — it has no DB
  credentials, so it writes its findings into `ai_scraped_registry.json` at the
  repo root and commits/pushes that file to `main`. THIS function is the other
  half: it has no web-search/LLM capability, but it DOES already have DB
  credentials (same NETLIFY_DATABASE_URL every other scraper uses), so its only
  job is to read that registry and land its `findings` into the real
  `job_posts` table via the exact same shared filter/upsert pipeline every
  other AI-scraped write path uses (_ai_ingest_core.mjs `ingestJobs`) — so a
  routine's own judgment call is never the ONLY gate; the same deterministic
  isItJob/isSeniorLike/isSeniorByYears checks apply here too.

  Deliberately NOT reading the file from the function's own bundle (Netlify's
  esbuild bundling only reliably includes the JS import graph, not arbitrary
  repo files) — instead it does a plain HTTPS fetch of the raw file from
  GitHub, the exact same "fetch a URL, parse it" shape every other scraper in
  this codebase already uses. Requires the repo to be public.

  IDEMPOTENT by design, not "process once and delete": every run re-upserts
  the ENTIRE `findings` array. `ON CONFLICT (source, url) DO UPDATE` (the same
  upsert every scraper uses) makes re-processing an already-synced entry a
  harmless no-op — so there's no need for this function to mutate/shrink the
  registry file (which it couldn't do anyway; a serverless function has no
  git-push credentials). The routine's registry keeps growing; this function
  just keeps replaying it into the DB.
*/

import { Pool } from "pg";
import { loadFilters } from "./load_filters.mjs";
import { loadCategories } from "./load_categories.mjs";
import { withTimeout } from "./_error-logger.mjs";
import { ingestJobs } from "./_ai_ingest_core.mjs";

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

const REGISTRY_URL =
  "https://raw.githubusercontent.com/Andrssss/MyWebsite/main/ai_scraped_registry.json";

async function fetchRegistry() {
  const res = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(20000) });
  if (res.status === 404) return null; // routine hasn't run / pushed yet — not an error
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching registry`);
  return res.json();
}

// slug → "AI - slug", matching every other AI-scraped write path exactly
// (ai-ingest.mjs, ai-extractors.js, cron_jobs_AI-background.mjs).
function sourceFor(slug) {
  return `AI - ${String(slug || "").trim()}`;
}

function groupBySource(findings) {
  const groups = new Map();
  for (const f of findings || []) {
    if (!f || !f.title || !f.url) continue;
    const source = sourceFor(f.slug);
    if (!groups.has(source)) groups.set(source, []);
    groups.get(source).push({
      title: f.title,
      url: f.url,
      company: f.company || null,
      location: f.location || null,
      experience: f.experience || null,
      technologies: f.technologies || null,
    });
  }
  return groups;
}

async function syncRegistry(client) {
  const registry = await fetchRegistry();
  if (!registry) {
    console.log("[ai-registry-sync] no registry file yet — nothing to sync");
    return;
  }

  const groups = groupBySource(registry.findings);
  if (groups.size === 0) {
    console.log("[ai-registry-sync] registry has no findings yet");
    return;
  }

  const [filters, categories] = await Promise.all([loadFilters(), loadCategories()]);

  for (const [source, jobs] of groups) {
    // fullListing:false — the registry accumulates finds across many runs/sites,
    // never a single site's complete current listing, so reconcile stays
    // reactivate-only here (same reasoning as every AI-scraped write path).
    const stats = await ingestJobs(client, { source, jobs, fullListing: false, filters, categories });
    console.log(
      `[ai-registry-sync] ${source}: rows=${stats.rows} inserted=${stats.inserted} ` +
      `skip_senior=${stats.skippedSenior} skip_company=${stats.skippedCompany} ` +
      `skip_non_it=${stats.skippedNonIt} reconcile=${JSON.stringify(stats.reconcile)}`
    );
  }
}

export const config = {
  // Offset 20 min past the routine's own "every 5 hours" schedule — the
  // routine's git push needs a little time to land on GitHub before this
  // fetches it; harmless if it's already there, just re-syncs what's new.
  schedule: "20 */5 * * *",
};

export default withTimeout("cron_ai_registry_sync-background", async () => {
  const client = await pool.connect();
  try {
    await syncRegistry(client);
  } finally {
    client.release();
  }
  return new Response("OK");
});
