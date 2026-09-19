// netlify/functions/tmp-langcat-rebuild.mjs
//
// DISPOSABLE, one-off endpoint (2026-09-19, GitHub issue #28). The category
// dimension on dailyLanguages/dailyTechnologies (_stats_core.mjs's
// technologyBreakdownByCategory(), wired into cron_daily_stats.mjs and
// _stats_rebuild_core.mjs's writeDays()) only affects new writes going
// forward — every row in the "job-stats" Blob written before this lands has
// no `category` field, so pestidev.hu's per-category language/technology
// dropdown shows "no data" for any category on any historical range. Per
// this repo's "stats are derived data — rebuild them, don't patch them"
// convention, a full-history rebuildStats() recomputes both the aggregate
// (no-category) and per-category rows from the raw job_posts + archive rows
// in one pass. Same mechanism/shape as tmp-hungarian-stats-rebuild.mjs
// (2026-09-17) — synchronous, not -background, since a full rebuild over
// this table's size previously completed in well under a second.
//
// Use once, then `git rm` this file per the repo's disposable tmp-*.mjs
// convention.
//
//   curl -s -X POST "https://bakan7.netlify.app/.netlify/functions/tmp-langcat-rebuild?token=TOKEN"
//   curl -s "https://bakan7.netlify.app/.netlify/functions/tmp-langcat-rebuild?token=TOKEN&action=readCategoryCoverage"

import pkg from "pg";
const { Pool } = pkg;
import { getStore } from "@netlify/blobs";
import { rebuildStats } from "./_stats_rebuild_core.mjs";
import { loadCategories } from "./load_categories.mjs";

const TOKEN = "1890c922cc2610e8f16ff2beb7cfd4350675fcf9";

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

function json(status, body) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export default async (request) => {
  const url = new URL(request.url);
  const token =
    url.searchParams.get("token") ||
    (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (token !== TOKEN) return json(401, { error: "Unauthorized" });

  if (url.searchParams.get("action") === "readCategoryCoverage") {
    const store = getStore("job-stats");
    const data = await store.get("latest.json", { type: "json" });
    const summarize = (rows) => {
      const withCat = rows.filter((r) => r.category);
      const withoutCat = rows.filter((r) => !r.category);
      const dates = rows.map((r) => r.date).sort();
      return {
        total: rows.length,
        withCategory: withCat.length,
        withoutCategory: withoutCat.length,
        dateRange: dates.length ? [dates[0], dates[dates.length - 1]] : null,
        categoriesSeen: [...new Set(withCat.map((r) => r.category))].sort(),
      };
    };
    return json(200, {
      ok: true,
      generatedAt: data?.generatedAt,
      dailyLanguages: summarize(data?.dailyLanguages || []),
      dailyTechnologies: summarize(data?.dailyTechnologies || []),
    });
  }

  const dryRun = url.searchParams.get("dryRun") === "1";

  const client = await pool.connect();
  try {
    const jobCategories = await loadCategories();
    const summary = await rebuildStats(client, jobCategories, { dryRun });
    return json(200, { ok: true, ...summary });
  } catch (err) {
    console.error("[tmp_langcat_rebuild]", err);
    return json(500, { error: err.message, stack: String(err.stack).split("\n").slice(0, 6) });
  } finally {
    client.release();
  }
};
