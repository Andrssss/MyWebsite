// DISPOSABLE — 2026-09-15. One-off read: dump active job_posts (title, company,
// source, url) so a local script can check whether cvonline.hu's IT category
// has postings that don't already exist under another source. Delete after use.
import { Pool } from "pg";

const TOKEN = "f3a8c1e6b2d9407fa5c8e1b6d3f9a0c74e2b8d61";
const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });

  const client = await pool.connect();
  try {
    const res = await client.query(
      `SELECT title, company, source, url FROM job_posts WHERE active = true`
    );
    return new Response(JSON.stringify(res.rows), {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  } finally {
    client.release();
  }
};
