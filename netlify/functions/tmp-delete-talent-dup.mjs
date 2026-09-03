// DISPOSABLE — hard-delete the 2 talent duplicate rows (2026-09-03), per
// user correction: deactivate is not the default for confirmed scraper-
// artifact dupes, delete is. Delete after use.
import { Pool } from "pg";

const connectionString = process.env.NETLIFY_DATABASE_URL;
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

const TOKEN = "tmp-delete-talent-dup-3c7f10";

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (auth !== TOKEN) return new Response("Unauthorized", { status: 401 });

  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `DELETE FROM job_posts WHERE id IN (3075716, 3077208) RETURNING id, url`
    );
    return new Response(JSON.stringify(rows, null, 2), {
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  } finally {
    client.release();
  }
};
