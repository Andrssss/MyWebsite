// TEMPORARY one-off endpoint — re-extracts job_posts.technologies for talent.com
// rows from the last 30 days using the FIXED extractTechnologies (2026-07-29:
// the zero-keyword-hits fallback was pulling sidebar "Hasonlo munkak" content
// into the technologies field on real, correctly-scoped descriptions). Reuses
// the real extractTechnologies/fetchText from _experience_core.mjs — does NOT
// reimplement extraction logic. Batched via ?offset=&limit= (default 25),
// caller invokes repeatedly until `done:true`. CRON_SECRET-independent one-off
// token, same precedent as tmp-tech-backfill/tmp-onefix. Delete after use.
import pkg from "pg";
const { Pool } = pkg;
import { fetchText, extractTechnologies } from "./_experience_core.mjs";

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });
const ONE_OFF_TOKEN = "8f3e1c9a7d2b4650fa9c3e7d1b8a4f602c5e9d3a71b6480e";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export default async (request) => {
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (token !== ONE_OFF_TOKEN) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  const url = new URL(request.url);
  const offset = parseInt(url.searchParams.get("offset") || "0", 10);
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "10", 10), 15);

  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT id, url, technologies FROM job_posts
       WHERE source = 'talent' AND first_seen >= NOW() - INTERVAL '30 days'
       ORDER BY id
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    let changed = 0, unchanged = 0, failed = 0;
    const changedRows = [];
    const failedRows = [];

    for (const row of rows) {
      try {
        const html = await fetchText(row.url);
        const fresh = extractTechnologies(html);
        const oldVal = row.technologies ?? null;
        if (fresh !== oldVal) {
          await client.query(`UPDATE job_posts SET technologies = $1 WHERE id = $2`, [fresh, row.id]);
          changed++;
          changedRows.push({ id: row.id, url: row.url, old: oldVal, fresh });
        } else {
          unchanged++;
        }
      } catch (err) {
        failed++;
        failedRows.push({ id: row.id, url: row.url, error: err.message });
      }
      await sleep(400);
    }

    return new Response(
      JSON.stringify({
        ok: true,
        offset, limit,
        fetchedThisBatch: rows.length,
        done: rows.length < limit,
        nextOffset: offset + rows.length,
        changed, unchanged, failed,
        changedRows, failedRows,
      }),
      { status: 200, headers: { "Content-Type": "application/json; charset=utf-8" } }
    );
  } finally {
    client.release();
  }
};
