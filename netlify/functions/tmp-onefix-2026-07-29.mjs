// TEMPORARY one-off endpoint — two tiny manual DB corrections found during the
// 2026-07-29 talent.com technologies-pollution bugfix (see conversation
// history / memory job-filters, technologies-extraction):
//   1. job_filters: add "Application Architecture" so senior/specialist
//      architecture titles like Kyndryl's "Mainframe Application Architecture"
//      get correctly senior-filtered (existing denylist only had specific
//      "X Architect" phrases, nothing matching this pattern).
//   2. job_posts: clear the one already-bad technologies value the
//      extractTechnologies fallback bug wrote for that same Kyndryl posting
//      (source=talent, url below) back to NULL.
// CRON_SECRET-independent one-off token, same precedent as tmp-tech-backfill.
// Delete this file (and this invocation) right after use — do not leave it.
import pkg from "pg";
const { Pool } = pkg;

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });
const ONE_OFF_TOKEN = "c12561f10da7e71e73a71862a341d59a1dd9bbb6ecbfe8a4";

const KYNDRYL_URL = "https://hu.talent.com/view?id=630291476594035978";

export default async (request) => {
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (token !== ONE_OFF_TOKEN) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  const client = await pool.connect();
  try {
    const filterResult = await client.query(
      `INSERT INTO job_filters (word) VALUES ('Application Architecture')
       ON CONFLICT (LOWER(word)) DO NOTHING
       RETURNING id, word`
    );

    const jobResult = await client.query(
      `UPDATE job_posts SET technologies = NULL
       WHERE source = 'talent' AND url = $1
       RETURNING id, source, title, technologies`,
      [KYNDRYL_URL]
    );

    return new Response(
      JSON.stringify({
        ok: true,
        filterInserted: filterResult.rows[0] || "already existed",
        jobUpdated: jobResult.rows[0] || "no matching row",
      }),
      { status: 200, headers: { "Content-Type": "application/json; charset=utf-8" } }
    );
  } finally {
    client.release();
  }
};
