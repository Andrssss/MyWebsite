// Disposable one-off read-only endpoint (2026-08-06): dump technologies field
// for every AI-scraped row so it can be audited against _tech_keywords.js
// canonical list. Deploy -> invoke -> delete this file.
import { Pool } from "pg";

const connectionString = process.env.NETLIFY_DATABASE_URL;
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

const TOKEN = "ai-tech-dump-7c1f9a3e2b6d4058";

export default async (req) => {
  const hdr = req.headers.get("authorization") || "";
  const token = hdr.replace(/^Bearer\s+/i, "").trim();
  if (token !== TOKEN) {
    return new Response("Unauthorized", { status: 401 });
  }

  const client = await pool.connect();
  try {
    const result = await client.query(
      `SELECT url, title, technologies, active, hidden
       FROM job_posts
       WHERE source = 'AI-scraped'
       ORDER BY first_seen`
    );
    return new Response(JSON.stringify({ count: result.rowCount, rows: result.rows }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } finally {
    client.release();
  }
};
