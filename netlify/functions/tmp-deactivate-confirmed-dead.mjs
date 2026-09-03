// DISPOSABLE write endpoint — 2026-09-04. Deactivates a fixed list of URLs
// already confirmed dead (double-checked) by the full-source active-flag
// audit. Only sets active=false on an exact url+source match. Delete after use.

import { Pool } from "pg";

const TOKEN = "b4e1c9f7a3d6082e5f1a9c4b7d3e0f682a5c9d1e";
const pool = new Pool({ connectionString: process.env.NETLIFY_DATABASE_URL, ssl: { rejectUnauthorized: false } });

const URLS = [
  "https://jobs.siemens.com/en_US/externaljobs/JobDetail/515947",
  "https://jobs.ashbyhq.com/primer.io/4d2bb5ee-a601-48e3-879c-990e31ec7984",
];

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) {
    return new Response("unauthorized", { status: 401 });
  }

  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `UPDATE job_posts SET active = false
        WHERE url = ANY($1::text[]) AND source = 'AI-scraped' AND active = true
        RETURNING url, title`,
      [URLS]
    );
    return new Response(JSON.stringify({ deactivated: rows.length, rows }, null, 2), {
      headers: { "content-type": "application/json" },
    });
  } finally {
    client.release();
  }
};
