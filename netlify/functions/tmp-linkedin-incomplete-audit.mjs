// DISPOSABLE, READ-ONLY audit endpoint — 2026-09-04.
//
// How many active LinkedIn rows currently have the exact same signature as
// the Tesco incident (no technologies AND experience = "-")? These are rows
// inserted before today's fix, where the detail fetch silently came back
// incomplete and got saved anyway. No writes. Delete after use.

import { Pool } from "pg";

const TOKEN = "b7f2c9e14a6d8031f5e7c2a90b4d6f18c3a5e7b9";
const pool = new Pool({ connectionString: process.env.NETLIFY_DATABASE_URL, ssl: { rejectUnauthorized: false } });

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });

  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT id, url, title, company, first_seen
         FROM job_posts
        WHERE source = 'LinkedIn'
          AND active = true
          AND (technologies IS NULL OR technologies = '')
          AND experience = '-'
        ORDER BY first_seen DESC`
    );
    return new Response(JSON.stringify({ count: rows.length, rows }, null, 2), {
      headers: { "content-type": "application/json" },
    });
  } finally {
    client.release();
  }
};
