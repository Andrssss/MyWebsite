// DISPOSABLE — inspect talent-source duplicate "Market Data System Engineer"
// rows reported 2026-09-03. Delete after use.
import { Pool } from "pg";

const connectionString = process.env.NETLIFY_DATABASE_URL;
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

const TOKEN = "tmp-debug-talent-dup-8f2a91";

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (auth !== TOKEN) return new Response("Unauthorized", { status: 401 });

  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT id, source, title, url, company, active, first_seen
       FROM job_posts
       WHERE title ILIKE '%Market Data System Engineer%'
       ORDER BY first_seen`
    );
    return new Response(JSON.stringify(rows, null, 2), {
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  } finally {
    client.release();
  }
};
