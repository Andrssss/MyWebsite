// DISPOSABLE — 2026-09-15. Post-run check for the new cvonline scraper smoke
// test: row counts + a sample so the result can be eyeballed. Delete after use.
import { Pool } from "pg";

const TOKEN = "a7c1e5b9d3f2084ae6c9b1d4f7a0e3c85b2d61f9";
const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });

  const client = await pool.connect();
  try {
    const counts = await client.query(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE active)::int AS active
         FROM job_posts WHERE source = 'cvonline'`
    );
    const sample = await client.query(
      `SELECT title, company, experience, technologies, level, active, url
         FROM job_posts WHERE source = 'cvonline' ORDER BY first_seen DESC LIMIT 20`
    );
    return new Response(JSON.stringify({ counts: counts.rows[0], sample: sample.rows }, null, 2), {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  } finally {
    client.release();
  }
};
