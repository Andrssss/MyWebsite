// TEMPORARY one-off — dump every AI-scraped row (including hidden ones, which
// the public jobs.js API never returns without an admin cookie) so bad rows
// from a bug (generic career-page URL submitted instead of a real per-posting
// URL) can be found and fixed. Read-only. Delete after use.
import pkg from "pg";
const { Pool } = pkg;

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });
const ONE_OFF_TOKEN = "e1c4a7f2b9d6053e8a1f4c7b0d3e6a9f2c5b8e1d4a7f0c3b";

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
      `SELECT source, title, url, company, location, experience, technologies, hidden, active, first_seen
       FROM job_posts WHERE source = 'AI-scraped' ORDER BY first_seen DESC`
    );
    return json(200, { count: res.rows.length, rows: res.rows });
  } finally {
    client.release();
  }
};
