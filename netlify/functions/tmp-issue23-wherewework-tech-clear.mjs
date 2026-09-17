// DISPOSABLE — 2026-09-17. GH issue #23 cleanup: cron_jobs_DIAK_3-background.mjs
// no longer extracts `technologies` for the wherewework source (see commit
// "Stop extracting fake technologies from wherewework detail pages") because
// its detail page carries no real per-posting body at all — the whole "Job
// description" section is a generic marketing blurb templated per job title,
// so every previously-stored technologies value for this source was derived
// from that boilerplate (or nav/sidebar noise), never the employer's actual
// requirements. This clears the existing misleading values so nothing already
// in job_posts keeps showing a false tech tag. GET reports the current count
// (+ a sample); POST {"action":"clear"} nulls technologies for every
// source='wherewework' row that currently has one. Delete this file after use.
import { Pool } from "pg";

const TOKEN = "b17c4f5e9a2d6083f7e1c9a4b6d0358f2e7a1c9d4b6083f7";
const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });

  const client = await pool.connect();
  try {
    if (request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      if (body.action !== "clear") {
        return new Response(JSON.stringify({ error: "expected {action:'clear'}" }), {
          status: 400,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
      const { rowCount } = await client.query(
        `UPDATE job_posts SET technologies = NULL WHERE source = 'wherewework' AND technologies IS NOT NULL`
      );
      return new Response(JSON.stringify({ cleared: rowCount }), {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    const { rows: countRows } = await client.query(
      `SELECT active, count(*)::int AS n FROM job_posts WHERE source = 'wherewework' AND technologies IS NOT NULL GROUP BY active`
    );
    const { rows: sample } = await client.query(
      `SELECT id, url, title, company, technologies, active, first_seen
         FROM job_posts WHERE source = 'wherewework' AND technologies IS NOT NULL
         ORDER BY first_seen DESC LIMIT 15`
    );
    return new Response(JSON.stringify({ byActive: countRows, sample }, null, 2), {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  } finally {
    client.release();
  }
};
