// TEMPORARY one-off — deactivate the Graphisoft "Junior AI Engineer" AI-scraped
// row, confirmed filled 2026-07-30 (user saw "Sorry, this position has been
// filled." on the live page). Durable detection for this ATS added to
// BANNER_DEAD_SOURCES in _active_core.mjs; this just fixes the one row
// immediately instead of waiting for tomorrow's sweep. Delete after use.
import pkg from "pg";
const { Pool } = pkg;

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });
const ONE_OFF_TOKEN = "9c2a7e5f1d4b6830a4e2f7c1b9d5a8e6f3c0b7d4a1e8f5c2";
const URL_TO_KILL =
  "https://atj.graphisoft.com/job/Budapest-Junior-AI-Engineer-1031/1353220757/?feedId=351702&tcsource=apply";

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export default async (request) => {
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (token !== ONE_OFF_TOKEN) return json(401, { error: "Unauthorized" });

  const client = await pool.connect();
  try {
    const res = await client.query(
      `UPDATE job_posts SET active = false WHERE source = 'AI-scraped' AND url = $1 RETURNING url, active`,
      [URL_TO_KILL]
    );
    return json(200, { updated: res.rows });
  } finally {
    client.release();
  }
};
