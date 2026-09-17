// DISPOSABLE — 2026-09-17. Read-only spot check for the GH issue #20
// merge (tmp-profession-dupe-merge.mjs): confirms a kept row's merged
// technologies/active state and that the dropped sibling id is gone.
// Delete after use.
import { Pool } from "pg";

const TOKEN = "d2c8f4917ab6e35c0d9f8a2b6e174c3095fd8a2c7e916b3d";
const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

const KEPT_IDS = [1997634, 1811619, 2392228, 2409902];
const DROPPED_IDS = [3282171, 3282255, 2751893, 2751884];

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });

  const client = await pool.connect();
  try {
    const kept = await client.query(
      `SELECT id, source, title, company, url, technologies, active, sweep_dead, first_seen FROM job_posts WHERE id = ANY($1::int[]) ORDER BY id`,
      [KEPT_IDS]
    );
    const dropped = await client.query(
      `SELECT id FROM job_posts WHERE id = ANY($1::int[])`,
      [DROPPED_IDS]
    );
    const totalProfession = await client.query(
      `SELECT COUNT(*) AS n FROM job_posts WHERE source = 'profession-intern'`
    );
    return new Response(
      JSON.stringify(
        {
          kept: kept.rows,
          droppedStillPresent: dropped.rows,
          totalProfessionRows: totalProfession.rows[0].n,
        },
        null,
        2
      ),
      { headers: { "content-type": "application/json; charset=utf-8" } }
    );
  } finally {
    client.release();
  }
};
