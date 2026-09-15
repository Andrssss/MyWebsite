// DISPOSABLE — 2026-09-15. Quick diagnostic: how many active nofluffjobs
// rows are in scope for tmp-nfj-polish-backfill-background.mjs, and how
// many already got touched by its earlier (prematurely-killed) runs.
// Delete after use.
import { Pool } from "pg";

const TOKEN = "b4e7f1a9c2d6083f5b7e1a9c4d8f2b6e0a3c7d15";
const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });

  const client = await pool.connect();
  try {
    const total = await client.query(
      `SELECT count(*)::int AS n FROM job_posts WHERE source = 'nofluffjobs' AND active = true`
    );
    const withPolish = await client.query(
      `SELECT count(*)::int AS n FROM job_posts WHERE source = 'nofluffjobs' AND active = true AND technologies LIKE '%Polish%'`
    );
    return new Response(
      JSON.stringify({ activeNofluffRows: total.rows[0].n, alreadyHavePolish: withPolish.rows[0].n }, null, 2),
      { headers: { "content-type": "application/json; charset=utf-8" } }
    );
  } finally {
    client.release();
  }
};
