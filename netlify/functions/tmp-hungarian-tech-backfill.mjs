// netlify/functions/tmp-hungarian-tech-backfill.mjs
//
// DISPOSABLE, one-off endpoint (2026-09-17). extractTechnologies() gained a
// looksLikeHungarianAd() check (see _experience_core.mjs) so NEW postings now
// get "Hungarian" added to job_posts.technologies the same way an
// English-language ad already gets "English" — but job_posts stores no raw
// description text, so EXISTING rows can only be corrected by re-fetching
// their live URL and re-running the (now-updated) extraction. This endpoint
// does that for every currently-ACTIVE row, merging in "Hungarian" (and,
// opportunistically, "English" — looksLikeEnglishAd predates this row's
// last extraction in some cases too) without touching anything else already
// stored in `technologies`. Inactive/archived rows are NOT covered — most
// are long dead, re-fetching them would mostly just fail, and nothing live
// reads them back except the stats rebuild (see CLAUDE.md's job-posts-archive
// entry) which only sums whatever technologies each row already has.
//
// Cursor-based on `id` (not offset), so repeated calls make guaranteed
// forward progress regardless of match outcome (an active row that's
// genuinely non-Hungarian would otherwise stay in a NOT-LIKE-'Hungarian'
// filter forever and get re-fetched every call).
//
// Use once, then `git rm` this file per the repo's disposable tmp-*.mjs
// convention (see the 2026-09-01 tmp-tech-heal.mjs precedent).
//
//   BASE=https://bakan7.netlify.app/.netlify/functions/tmp-hungarian-tech-backfill
//
//   # 1. size the job (no writes):
//   curl -s "$BASE?token=TOKEN&action=scan"
//
//   # 2. heal in a loop, feeding each response's nextAfterId back in, until
//   #    done:true:
//   curl -s -X POST "$BASE?token=TOKEN&action=heal&after_id=0&limit=40"

import pkg from "pg";
const { Pool } = pkg;
import "@netlify/blobs";
import { extractTechnologies, fetchText, ensureTechnologiesColumn } from "./_experience_core.mjs";
import { withDbAuditFlush } from "./_db_audit.js";

// Disposable, hardcoded token — deliberately not an env var (CRON_SECRET is
// masked in the CLI), gone with the file once this has run.
const TOKEN = "3e8c1a5f2b7d4906ae0c3f8b1d5a7e2c4f9b0d6a";

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

// Concurrent fetches per call, and an overall wall-clock budget so we return
// well inside Netlify's synchronous-function limit instead of timing out.
const CONCURRENCY = 20;
const BUDGET_MS = 8500;
const FETCH_TIMEOUT_MS = 6000;

function json(status, body) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function withDeadline(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout ${label}`)), ms)),
  ]);
}

function techList(tech) {
  return tech ? tech.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

async function scan(client) {
  const { rows: total } = await client.query(
    `SELECT COUNT(*)::int AS active_rows,
            COUNT(*) FILTER (WHERE technologies IS NULL OR technologies NOT LIKE '%Hungarian%')::int AS candidates
       FROM job_posts WHERE active`
  );
  const { rows: bySource } = await client.query(
    `SELECT source, COUNT(*)::int AS candidates
       FROM job_posts
      WHERE active AND (technologies IS NULL OR technologies NOT LIKE '%Hungarian%')
      GROUP BY 1 ORDER BY 2 DESC LIMIT 15`
  );
  return { ...total[0], bySource };
}

async function heal(client, afterId, limit) {
  const { rows: work } = await client.query(
    `SELECT id, url, technologies FROM job_posts
      WHERE active AND id > $1
      ORDER BY id ASC LIMIT $2`,
    [afterId, limit]
  );

  const started = Date.now();
  let processed = 0;
  let updatedHungarian = 0;
  let updatedEnglish = 0;
  let fetchFailed = 0;
  const samples = [];
  let lastId = afterId;
  let cursor = 0;

  async function worker() {
    while (cursor < work.length && Date.now() - started < BUDGET_MS) {
      const row = work[cursor++];
      processed++;
      lastId = Math.max(lastId, row.id);

      let html;
      try {
        html = await withDeadline(fetchText(row.url), FETCH_TIMEOUT_MS, row.url);
      } catch {
        fetchFailed++;
        continue;
      }

      const fresh = techList(extractTechnologies(html));
      const existing = techList(row.technologies);
      const toAdd = [];
      if (fresh.includes("Hungarian") && !existing.includes("Hungarian")) toAdd.push("Hungarian");
      if (fresh.includes("English") && !existing.includes("English")) toAdd.push("English");

      if (toAdd.length) {
        const merged = [...existing, ...toAdd].join(", ");
        await client.query(`UPDATE job_posts SET technologies = $1 WHERE id = $2`, [merged, row.id]);
        if (toAdd.includes("Hungarian")) updatedHungarian++;
        if (toAdd.includes("English")) updatedEnglish++;
        if (samples.length < 40) samples.push({ id: row.id, url: row.url, added: toAdd });
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  return {
    processed,
    updatedHungarian,
    updatedEnglish,
    fetchFailed,
    samples,
    nextAfterId: lastId,
    done: work.length < limit,
  };
}

export default withDbAuditFlush("tmp_hungarian_tech_backfill", async (request) => {
  const url = new URL(request.url);
  const token =
    url.searchParams.get("token") ||
    (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (token !== TOKEN) return json(401, { error: "Unauthorized" });

  const action = url.searchParams.get("action") || "scan";
  const limit = Math.min(Number(url.searchParams.get("limit")) || 40, 300);
  const afterId = Math.max(Number(url.searchParams.get("after_id")) || 0, 0);

  const client = await pool.connect();
  try {
    await ensureTechnologiesColumn(client);

    if (action === "scan") return json(200, { ok: true, ...(await scan(client)) });
    if (action === "heal") return json(200, { ok: true, ...(await heal(client, afterId, limit)) });
    return json(400, { error: `unknown action: ${action}` });
  } catch (err) {
    console.error("[tmp_hungarian_tech_backfill]", err);
    return json(500, { error: err.message, stack: String(err.stack).split("\n").slice(0, 4) });
  } finally {
    client.release();
  }
});
