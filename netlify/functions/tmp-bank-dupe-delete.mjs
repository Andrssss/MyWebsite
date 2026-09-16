// DISPOSABLE — 2026-09-16. GH issue #18 follow-up: delete the 5 confirmed
// aggregator-side duplicate rows found by tmp-bank-dupe-check3.mjs (removed),
// keeping the bank/mfb/raiffeisen source's own row per "prefer small
// scrapers over bigs". One-shot, ids hardcoded, no other write. Delete this
// file after use.
import { Pool } from "pg";

const TOKEN = "b7ec2457fc07f52cc68f9b145fb44f9e81c849b36066c98a";
const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

const IDS = [3012085, 2812637, 2225826, 2614044, 2626238];

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });

  const client = await pool.connect();
  try {
    const before = await client.query(
      `SELECT id, source, title, url FROM job_posts WHERE id = ANY($1::int[]) ORDER BY id`,
      [IDS]
    );
    const res = await client.query(`DELETE FROM job_posts WHERE id = ANY($1::int[])`, [IDS]);
    return new Response(
      JSON.stringify({ requested: IDS.length, deleted: res.rowCount, deletedRows: before.rows }, null, 2),
      { headers: { "content-type": "application/json; charset=utf-8" } }
    );
  } finally {
    client.release();
  }
};
