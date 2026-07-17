/*
  AI-scraped jobs worker — the AUTOMATED ingest path for the `ai-scraped` bucket.

  ⚠️ NOT on any schedule yet (see AI_SCRAPER_PLAN.md). Phase 1 is in-session /
  manual extraction via ai-ingest.js — this worker is the LATER automation that
  uses the Anthropic API to extract. When we turn it on, intended cadence is
  every 5 hours. Until then it only runs if triggered by hand.

  It is a normal background scraper: the ONLY difference from a hand-coded
  cron_jobs_<SOURCE> is that fetch+parse is done by _ai_extract_core.mjs (an LLM
  read, or a Claude-authored cheerio recipe) instead of hardcoded selectors.
  Everything after extraction — filtering, url-keyed upsert, reconcile — is the
  shared _ai_ingest_core.mjs tail, identical to the in-session path.

  Sites are data-driven from `ai_extractors` (managed via ai-extractors.js); each
  writes to source `AI - <site>`. INVARIANT (§5): only NEW sites, never ones we
  already scrape. Requires Authorization: Bearer $CRON_SECRET.
*/

import { Pool } from "pg";
import { loadFilters } from "./load_filters.mjs";
import { loadCategories } from "./load_categories.mjs";
import { logFetchError, withTimeout } from "./_error-logger.mjs";
import { ingestJobs } from "./_ai_ingest_core.mjs";
import {
  extractJobsLLM,
  authorRecipe,
  runRecipe,
  estimateCost,
  MODEL,
} from "./_ai_extract_core.mjs";

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

let _filters = [];
let _categories = [];

/* ── schema ──────────────────────────────────────────────────────── */

async function ensureAiExtractorsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ai_extractors (
      site         text PRIMARY KEY,
      source_value text NOT NULL,
      list_url     text NOT NULL,
      mode         text NOT NULL DEFAULT 'llm-read',
      recipe       jsonb,
      recipe_model text,
      last_ok      timestamptz,
      last_regen   timestamptz,
      fail_streak  int NOT NULL DEFAULT 0
    )
  `);
  // full_listing: does list_url show the ENTIRE current listing in one fetch?
  // Only then may reconcile deactivate vanished rows. Default false = the page
  // is a window (paginated / recent-only), so reconcile is reactivate-only and
  // the shared 404 sweep is the sole deactivator (talent/nofluffjobs pattern) —
  // this makes wrongly deactivating page-2+ jobs impossible by default.
  await client.query(
    `ALTER TABLE ai_extractors ADD COLUMN IF NOT EXISTS full_listing boolean NOT NULL DEFAULT false`
  );
}

/* ── fetch ───────────────────────────────────────────────────────── */

async function fetchPage(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
      "Accept-Language": "hu-HU,hu;q=0.9,en;q=0.8",
    },
    signal: AbortSignal.timeout(25000),
  });
  if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

/* ── per-site extraction (mode decides whether the LLM is called) ── */

// Returns { jobs, usage, recipe } where recipe is a freshly-authored recipe to
// persist (or null).
async function extractForSite(site, html) {
  const baseUrl = site.list_url;
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const add = (u) => {
    for (const k of Object.keys(usage)) usage[k] += u[k] || 0;
  };

  // recipe mode with a working recipe → zero LLM calls.
  if (site.mode === "recipe" && site.recipe) {
    const jobs = runRecipe(html, site.recipe, { baseUrl });
    if (jobs.length > 0) return { jobs, usage, recipe: null };
    // Recipe produced nothing — markup likely changed. Regenerate + llm-read fallback THIS run.
    console.warn(`[AI - ${site.site}] recipe yielded 0 rows — regenerating + llm-read fallback`);
    const authored = await authorRecipe(html, { baseUrl });
    add(authored.usage);
    const read = await extractJobsLLM(html, { baseUrl });
    add(read.usage);
    return { jobs: read.jobs, usage, recipe: authored.recipe };
  }

  // recipe mode but no recipe yet → author one, and llm-read the rows this run.
  if (site.mode === "recipe") {
    const authored = await authorRecipe(html, { baseUrl });
    add(authored.usage);
    const read = await extractJobsLLM(html, { baseUrl });
    add(read.usage);
    return { jobs: read.jobs, usage, recipe: authored.recipe };
  }

  // llm-read (default) — every run reads the page.
  const read = await extractJobsLLM(html, { baseUrl });
  add(read.usage);
  return { jobs: read.jobs, usage, recipe: null };
}

async function runSite(client, site) {
  const source = site.source_value;

  let html;
  try {
    html = await fetchPage(site.list_url);
  } catch (err) {
    await logFetchError("cron_jobs_AI-background", { url: site.list_url, message: err.message });
    await bumpFailure(client, site);
    return;
  }

  let jobs, usage, recipe;
  try {
    ({ jobs, usage, recipe } = await extractForSite(site, html));
  } catch (err) {
    await logFetchError("cron_jobs_AI-background", { url: site.list_url, message: `extract: ${err.message}` });
    await bumpFailure(client, site);
    return;
  }

  const stats = await ingestJobs(client, {
    source,
    jobs,
    fullListing: site.full_listing,
    filters: _filters,
    categories: _categories,
  });
  const cost = estimateCost(usage);

  await recordResult(client, site, { ok: stats.ok, recipe });

  console.log(
    `[AI - ${site.site}] mode=${site.mode} rows=${stats.rows} upserted=${stats.inserted} ` +
    `skip_senior=${stats.skippedSenior} skip_company=${stats.skippedCompany} ok=${stats.ok} ` +
    `full_listing=${site.full_listing} complete=${stats.complete} ` +
    `cost=$${cost.toFixed(4)} reconcile=${JSON.stringify(stats.reconcile)}`
  );
}

/* ── ai_extractors bookkeeping ───────────────────────────────────── */

async function bumpFailure(client, site) {
  await client.query(`UPDATE ai_extractors SET fail_streak = fail_streak + 1 WHERE site = $1`, [site.site]);
}

async function recordResult(client, site, { ok, recipe }) {
  if (recipe) {
    await client.query(
      `UPDATE ai_extractors SET recipe = $2, recipe_model = $3, last_regen = NOW() WHERE site = $1`,
      [site.site, JSON.stringify(recipe), MODEL]
    );
  }
  if (ok) {
    await client.query(`UPDATE ai_extractors SET last_ok = NOW(), fail_streak = 0 WHERE site = $1`, [site.site]);
  } else {
    await bumpFailure(client, site);
  }
}

/* ── main ────────────────────────────────────────────────────────── */

async function scrapeAll(client) {
  await ensureAiExtractorsTable(client);
  const { rows: sites } = await client.query(
    `SELECT site, source_value, list_url, mode, recipe, full_listing, fail_streak
       FROM ai_extractors
      WHERE mode <> 'disabled'
      ORDER BY site`
  );
  if (sites.length === 0) {
    console.log("[ai] no active sites in ai_extractors — nothing to do");
    return;
  }
  console.log(`[ai] running ${sites.length} site(s), model=${MODEL}`);
  for (const site of sites) {
    try {
      await runSite(client, site);
    } catch (err) {
      // One site's failure must never abort the batch.
      await logFetchError("cron_jobs_AI-background", { url: site.list_url, message: `site: ${err.message}` });
      console.error(`[AI - ${site.site}] failed: ${err.message}`);
    }
  }
}

/* ── handler ─────────────────────────────────────────────────────── */

const _runJob = withTimeout("cron_jobs_AI-background", async () => {
  [_filters, _categories] = await Promise.all([loadFilters(), loadCategories()]);
  const client = await pool.connect();
  try {
    await scrapeAll(client);
  } finally {
    client.release();
  }
  return new Response("OK");
});

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  const expected = process.env.CRON_SECRET;
  if (!expected || token !== expected) {
    return new Response("Unauthorized", { status: 401 });
  }
  return _runJob(request);
};
