// Disposable one-off write endpoint (2026-08-06): reactivate the specific
// talent.com job wrongly killed by the soft-404 sweep bug fixed in
// _active_core.mjs (id 630535740167293230, "Network Engineer", H-Tech
// Supports). Also clears sweep_dead so it isn't sticky-blocked from future
// listing-based reactivation. Deploy -> invoke -> delete this file.
import { Pool } from "pg";

const connectionString = process.env.NETLIFY_DATABASE_URL;
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

const TOKEN = "reactivate-talent-9f2e7c4a1d803b6f";
const URL_TO_FIX = "https://hu.talent.com/view?id=630535740167293230";

export default async (req) => {
  const hdr = req.headers.get("authorization") || "";
  const token = hdr.replace(/^Bearer\s+/i, "").trim();
  if (token !== TOKEN) {
    return new Response("Unauthorized", { status: 401 });
  }

  const client = await pool.connect();
  try {
    const result = await client.query(
      `UPDATE job_posts
       SET active = true, sweep_dead = false
       WHERE url = $1
       RETURNING url, title, company, active, sweep_dead`,
      [URL_TO_FIX]
    );
    return new Response(JSON.stringify({ updated: result.rowCount, rows: result.rows }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } finally {
    client.release();
  }
};
