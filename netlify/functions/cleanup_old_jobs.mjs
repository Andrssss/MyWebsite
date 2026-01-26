// netlify/functions/cleanup_old_jobs.mjs
console.log("CLEANUP_OLD_JOBS LOADED");

// Weekly – every Monday 01:30 UTC (állítsd ahogy akarod)
export const config = {
  schedule: "30 1 * * 1",
};

import pkg from "pg";
const { Pool } = pkg;

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

export default async () => {
  const client = await pool.connect();
  try {
    // törlés 2 hónapnál régebbi first_seen alapján
    const sql = `
      DELETE FROM job_posts
      WHERE first_seen < (NOW() - INTERVAL '2 months')
    `;

    const res = await client.query(sql);

    console.log("[cleanup] deleted rows:", res.rowCount);

    return new Response(`Cleanup OK. Deleted: ${res.rowCount}`, { status: 200 });
  } catch (err) {
    console.error("[cleanup] failed:", err);
    return new Response("Cleanup failed", { status: 500 });
  } finally {
    client.release();
  }
};
