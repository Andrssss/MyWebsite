// DISPOSABLE row lookup — 2026-09-09. Delete after use.
import { Pool } from "pg";

const TOKEN = "9f2c7a41e6b830d5f174c2a90b6e83d1a5c7e02f9b41d637";
const connectionString = process.env.NETLIFY_DATABASE_URL;
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });
  const urlParam = new URL(request.url).searchParams.get("like");
  if (!urlParam) return new Response("missing ?like=", { status: 400 });

  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT id, url, source, title, company, active, experience, technologies, first_seen
         FROM job_posts WHERE url LIKE $1 ORDER BY id`,
      [`%${urlParam}%`]
    );
    return new Response(JSON.stringify(rows, null, 2), { headers: { "content-type": "application/json" } });
  } finally {
    client.release();
  }
};
