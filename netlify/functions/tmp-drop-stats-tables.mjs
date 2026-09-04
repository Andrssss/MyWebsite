// DISPOSABLE — one-off cleanup endpoint. Deploy, invoke once, then delete.
// See CLAUDE.md "Deploy & one-off writes workflow".
//
// job_daily_stats / job_daily_categories moved to the "job-stats" Netlify
// Blob store on 2026-09-04 (see _daily_stats_store.mjs); pestidev.hu's
// /stats page was confirmed live on the blob the same day. Nothing reads
// these two tables anymore — this drops them.

import pkg from "pg";
const { Pool } = pkg;

const TOKEN = "b36c8ca806028312ad906d9e22cb8b7cda128a4931c1540e";

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

export default async (req) => {
  const auth = req.headers.get("authorization") || "";
  if (auth !== `Bearer ${TOKEN}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const client = await pool.connect();
  try {
    const { rows: statsRows } = await client.query(`SELECT COUNT(*)::int AS n FROM job_daily_stats`);
    const { rows: catRows } = await client.query(`SELECT COUNT(*)::int AS n FROM job_daily_categories`);

    await client.query("DROP TABLE job_daily_stats");
    await client.query("DROP TABLE job_daily_categories");

    return new Response(
      JSON.stringify(
        {
          dropped: ["job_daily_stats", "job_daily_categories"],
          rowsAtDropTime: { job_daily_stats: statsRows[0].n, job_daily_categories: catRows[0].n },
        },
        null,
        2
      ),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }, null, 2), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  } finally {
    client.release();
  }
};
