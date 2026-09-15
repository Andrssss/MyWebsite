// DISPOSABLE — 2026-09-15. Direct lookup of the reported Tulip "DevX Engineer"
// (gh_jid=7821217003) row's current DB state, plus any other tulip rows.
// Delete after use.
import { Pool } from "pg";

const TOKEN = "3444d3b9034ca77000d602c4adaecbed22e4551b";
const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });

  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT *
       FROM job_posts
       WHERE url ILIKE $1 OR (title ILIKE $2 AND company ILIKE $3)
       ORDER BY id`,
      ["%7821217003%", "%DevX Engineer%", "%Tulip%"]
    );
    return new Response(JSON.stringify(rows, null, 2), {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  } finally {
    client.release();
  }
};
