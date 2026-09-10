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
const BATCH_LIMIT = 60;
const CONCURRENCY = 6;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });

  const url = new URL(request.url);

  if (url.searchParams.get("check") === "elk-remaining") {
    const client = await pool.connect();
    try {
      const { rows } = await client.query(`
        SELECT source, COUNT(*)::int AS cnt
        FROM job_posts
        WHERE active = true AND technologies LIKE '%ELK Stack%' AND technologies LIKE '%ELT%'
        GROUP BY source ORDER BY cnt DESC
      `);
      const sap = await client.query(`
        SELECT source, COUNT(*)::int AS cnt FROM job_posts
        WHERE active = true AND source IN ('otp','kuka') AND technologies LIKE '%SAP%'
        GROUP BY source
      `);
      const mbhLinux = await client.query(`
        SELECT id, title, url, technologies FROM job_posts
        WHERE active = true AND source = 'mbh' AND technologies LIKE '%Node.js%'
      `);
      return new Response(JSON.stringify({
        elkAndEltStillTogether: rows,
        otpKukaStillHaveSAP: sap.rows,
        mbhStillHasNodeJs: mbhLinux.rows,
      }, null, 2), { headers: { "content-type": "application/json; charset=utf-8" } });
    } finally {
      client.release();
    }
  }

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
    let idx = 0;

    while (idx < rows.length) {
      if (Date.now() - start > BUDGET_MS) break;
      const chunk = rows.slice(idx, idx + CONCURRENCY);
      idx += chunk.length;

      const results = await Promise.all(
        chunk.map(async (row) => {
          try {
            const html = await fetchText(row.url);
            return { row, newTech: extractTechnologies(html) };
          } catch (err) {
            return { row, error: err.message };
          }
        })
      );

      for (const r of results) {
        processed++;
        lastId = r.row.id;
        if (r.error) {
          errors++;
          changes.push({ id: r.row.id, url: r.row.url, error: r.error });
          continue;
        }
        const before = r.row.technologies;
        if ((before ?? null) !== (r.newTech ?? null)) {
          await client.query(
            `UPDATE job_posts SET technologies = $1 WHERE id = $2 AND technologies IS NOT DISTINCT FROM $3`,
            [r.newTech, r.row.id, before]
          );
          updated++;
          changes.push({ id: r.row.id, url: r.row.url, before, after: r.newTech });
        } else {
          unchanged++;
        }
      }
      await sleep(150);
    }

    const hasMore = rows.length === BATCH_LIMIT || processed < rows.length;

    return new Response(JSON.stringify({
      source, afterId, lastId, processed, updated, unchanged, errors, hasMore, changes,
    }, null, 2), { headers: { "content-type": "application/json; charset=utf-8" } });
  } finally {
    client.release();
  }
};
