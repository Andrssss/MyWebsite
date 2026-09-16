// DISPOSABLE — 2026-09-16. One-off data fix: a single legacy `job_posts` row
// has source = "ai-scraped" (lowercase), a fossil that predates the AI_SOURCE
// constant in _ai_ingest_core.mjs. jobs.js's /jobs/sources GROUP BY is
// case-sensitive, so that row didn't match FIXED's "AI-scraped" key and
// rendered as its own 1-row bucket next to the real 485-row "AI-scraped"
// bucket. Folds it into the canonical bucket. The write side is already
// guarded against recurrence (ingestJobs now canonicalizes any case-variant
// of AI_SOURCE — see _ai_ingest_core.mjs). Delete this file after running it.
import { Pool } from "pg";

const TOKEN = "f2a7c9e14b6d038f5a1c7e9b2d604f8a3c1e7b95";
const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });

  const client = await pool.connect();
  try {
    // `job_posts` upserts key on (source, url) — if the same url already
    // exists under the canonical "AI-scraped" source (the two rows raced
    // each other in at some point), a plain UPDATE would hit that unique
    // constraint. Drop the lowercase duplicate in that case; otherwise
    // re-point it at the canonical source, which is the actual migration.
    const { rows: stale } = await client.query(`SELECT id, url FROM job_posts WHERE source = 'ai-scraped'`);
    const deleted = [];
    const migrated = [];
    for (const row of stale) {
      const { rows: dupe } = await client.query(
        `SELECT id FROM job_posts WHERE source = 'AI-scraped' AND url = $1`,
        [row.url]
      );
      if (dupe.length > 0) {
        await client.query(`DELETE FROM job_posts WHERE id = $1`, [row.id]);
        deleted.push(row);
      } else {
        await client.query(`UPDATE job_posts SET source = 'AI-scraped' WHERE id = $1`, [row.id]);
        migrated.push(row);
      }
    }
    return new Response(JSON.stringify({ ok: true, migrated, deleted }, null, 2), {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  } finally {
    client.release();
  }
};
