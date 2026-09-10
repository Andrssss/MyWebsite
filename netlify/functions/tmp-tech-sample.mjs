// DISPOSABLE — 2026-09-10. Read-only: sample a few active rows (title/url/
// stored technologies) per source, for independent live spot-checking of
// sources not yet deeply verified in today's tech-extraction audit.
import { Pool } from "pg";

const TOKEN = "c4a1e7b9d2f6035a8c1e4b7d0a3f6c9852e5b8d1a4f7";
const connectionString = process.env.NETLIFY_DATABASE_URL;
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });

  const url = new URL(request.url);
  const sources = (url.searchParams.get("sources") || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!sources.length) return new Response(JSON.stringify({ error: "sources required" }), { status: 400 });

  const client = await pool.connect();
  try {
    const out = {};
    for (const source of sources) {
      const { rows } = await client.query(
        `SELECT id, title, url, technologies FROM job_posts
         WHERE active = true AND source = $1
         ORDER BY random() LIMIT 4`,
        [source]
      );
      out[source] = rows;
    }
    return new Response(JSON.stringify(out, null, 2), { headers: { "content-type": "application/json; charset=utf-8" } });
  } finally {
    client.release();
  }
};
