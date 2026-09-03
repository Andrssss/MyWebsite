// DISPOSABLE investigation endpoint — 2026-09-04. Checking why specific
// LinkedIn duplicate pairs (kostal, aegon x2, salio) that were in the earlier
// 30-cluster list are no longer showing up in the same-source dupe query.
// Read-only. Delete after use.

import { Pool } from "pg";

const TOKEN = "f68f2505bc3210402ee3299846a64b9361e14ee8";
const pool = new Pool({ connectionString: process.env.NETLIFY_DATABASE_URL, ssl: { rejectUnauthorized: false } });

const CHECK = [
  { company: "kostal", urlLike: "%kostal%" },
  { company: "aegon", urlLike: "%aegon%" },
  { company: "salio", urlLike: "%salio%" },
];

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) {
    return new Response("unauthorized", { status: 401 });
  }

  const client = await pool.connect();
  try {
    const results = {};
    for (const c of CHECK) {
      const { rows } = await client.query(
        `SELECT id, source, company, title, url, active, first_seen, technologies
           FROM job_posts
          WHERE source = 'LinkedIn' AND url ILIKE $1
          ORDER BY first_seen DESC`,
        [c.urlLike]
      );
      results[c.company] = rows;
    }
    return new Response(JSON.stringify(results, null, 2), {
      headers: { "content-type": "application/json" },
    });
  } finally {
    client.release();
  }
};
