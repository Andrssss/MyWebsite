// DISPOSABLE — 2026-09-10. Re-extracts job_posts.technologies for active
// rows of a given source, using the just-fixed extractTechnologies() (see
// _experience_core.mjs — #adv/.jobdescription/.jobAdvertisement__content
// pre-checks). Fixes the stale wrong values already stored for
// profession-intern / otp / kuka / mbh from before that fix.
// Batched + time-budgeted (Netlify function execution limit); call
// repeatedly with ?afterId=<lastId from previous response> until
// hasMore:false. Each UPDATE is guarded on the row's prior stored value so a
// concurrent write from a live scraper run is never clobbered. Delete after use.
import { Pool } from "pg";
import { fetchText, extractTechnologies } from "./_experience_core.mjs";

const TOKEN = "b7e4f19a2c6d8035e9f1a4c7b0d3e6f9852a1c4d7e0";
const connectionString = process.env.NETLIFY_DATABASE_URL;
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

const BUDGET_MS = 9000;
const BATCH_LIMIT = 25;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });

  const url = new URL(request.url);
  const source = url.searchParams.get("source");
  const afterId = parseInt(url.searchParams.get("afterId") || "0", 10);
  if (!source) return new Response(JSON.stringify({ error: "source required" }), { status: 400 });

  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT id, url, technologies FROM job_posts
       WHERE active = true AND source = $1 AND id > $2
       ORDER BY id ASC LIMIT $3`,
      [source, afterId, BATCH_LIMIT]
    );

    const start = Date.now();
    let processed = 0, updated = 0, unchanged = 0, errors = 0;
    const changes = [];
    let lastId = afterId;

    for (const row of rows) {
      if (Date.now() - start > BUDGET_MS) break;
      lastId = row.id;
      processed++;
      try {
        const html = await fetchText(row.url);
        const newTech = extractTechnologies(html);
        const before = row.technologies;
        const beforeNorm = before ?? null;
        const afterNorm = newTech ?? null;
        if (beforeNorm !== afterNorm) {
          await client.query(
            `UPDATE job_posts SET technologies = $1 WHERE id = $2 AND technologies IS NOT DISTINCT FROM $3`,
            [newTech, row.id, before]
          );
          updated++;
          changes.push({ id: row.id, url: row.url, before, after: newTech });
        } else {
          unchanged++;
        }
      } catch (err) {
        errors++;
        changes.push({ id: row.id, url: row.url, error: err.message });
      }
      await sleep(120);
    }

    const hasMore = rows.length === BATCH_LIMIT || processed < rows.length;

    return new Response(JSON.stringify({
      source, afterId, lastId, processed, updated, unchanged, errors, hasMore, changes,
    }, null, 2), { headers: { "content-type": "application/json; charset=utf-8" } });
  } finally {
    client.release();
  }
};
