// TEMPORARY one-off — read-only audit of every AI-scraped row's `technologies`
// value, to see how many contain labels outside the curated TECH_KEYWORDS list
// (_experience_core.mjs). 2026-08-01. Delete after use.
import pkg from "pg";
const { Pool } = pkg;

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });
const ONE_OFF_TOKEN = "b3f7c1a9d2e6485ab0912fd47c3e58a91b6d4f0e7c2a5891";

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
      `SELECT url, title, technologies FROM job_posts WHERE source = 'AI-scraped' AND technologies IS NOT NULL AND technologies <> '' ORDER BY first_seen DESC`
    );
    return json(200, { count: res.rows.length, rows: res.rows });
  } finally {
    client.release();
  }
};
