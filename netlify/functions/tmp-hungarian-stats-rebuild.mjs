// netlify/functions/tmp-hungarian-stats-rebuild.mjs
//
// DISPOSABLE, one-off endpoint (2026-09-17). After the Hungarian-ad-language
// backfill (tmp-hungarian-tech-backfill.mjs) updates job_posts.technologies,
// the "job-stats" Blob's dailyLanguages/dailyTechnologies aggregates (see
// _stats_core.mjs's technologyBreakdown, CLAUDE.md's job-stats Blob entry)
// are still stale snapshots of the OLD technologies values — they need a
// full rebuild from the now-corrected raw rows, same mechanism as the
// 2026-09-16 tmp-langtech-backfill-background.mjs. Per that note, a
// full-history rebuild over this table's size actually completes in
// seconds, so this is a plain synchronous function (not -background) —
// simpler, and its JSON response is the real result, not just Netlify's
// platform-level 202 for -background-suffixed functions.
//
// Use once, then `git rm` this file per the repo's disposable tmp-*.mjs
// convention.
//
//   curl -s -X POST "https://bakan7.netlify.app/.netlify/functions/tmp-hungarian-stats-rebuild?token=TOKEN"

import pkg from "pg";
const { Pool } = pkg;
import { rebuildStats } from "./_stats_rebuild_core.mjs";
import { loadCategories } from "./load_categories.mjs";

const TOKEN = "9d4f7b2a6e1c8035bf2d9a4e7c1b6083df5a2e9c";

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

  const dryRun = url.searchParams.get("dryRun") === "1";

  const client = await pool.connect();
  try {
    const jobCategories = await loadCategories();
    const summary = await rebuildStats(client, jobCategories, { dryRun });
    return json(200, { ok: true, ...summary });
  } catch (err) {
    console.error("[tmp_hungarian_stats_rebuild]", err);
    return json(500, { error: err.message, stack: String(err.stack).split("\n").slice(0, 6) });
  } finally {
    client.release();
  }
};
