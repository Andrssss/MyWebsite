import { Pool } from "pg";

const TOKEN = "tmp-ats-reactivate-2rows-c7c0b9d47daab1447ec5706471a9f7a20ef1518f8e96ae95";

const pool = new Pool({
  connectionString: process.env.NETLIFY_DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// 2026-09-09: these two ats-crawl rows are marked inactive in the DB but were
// independently confirmed live via two channels each (the ATS's own per-job
// API, and the tenant's full current board listing) and are unambiguously
// Budapest-located, so this isn't a policy-scope drop, just a stale flag.
const URLS = [
  "https://jobs.ashbyhq.com/seon/967f8224-0378-46d8-a728-b99844d98837",
  "https://jobs.lever.co/kpler/3fd5141a-d97c-4c72-9972-813ecfe4e3f0",
];

export default async (req) => {
  const auth = req.headers.get("authorization") || "";
  if (auth.replace(/^Bearer\s+/i, "").trim() !== TOKEN) {
    return new Response("unauthorized", { status: 401 });
  }

  const client = await pool.connect();
  try {
    const res = await client.query(
      `UPDATE job_posts
          SET active = true, sweep_dead = false
        WHERE source = 'ats-crawl'
          AND active = false
          AND url = ANY($1::text[])
        RETURNING url`,
      [URLS]
    );
    return new Response(
      JSON.stringify({ reactivated: res.rows.map((r) => r.url) }, null, 2),
      { headers: { "Content-Type": "application/json" } }
    );
  } finally {
    client.release();
  }
};
