// Disposable one-off backfill: job_posts.level for the last 30 days.
// Deploy → invoke (dry-run, then ?action=write) → delete this file.
import { Pool } from "pg";
import { computeLevel } from "../../src/lib/experienceLevel.mjs";

const TOKEN = "tmp-level-backfill-3f7c02de";

const pool = new Pool({
  connectionString: process.env.NETLIFY_DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

export default async (req) => {
  const auth = req.headers.get("authorization") || "";
  if (auth.replace(/^Bearer\s+/i, "").trim() !== TOKEN) {
    return new Response("unauthorized", { status: 401 });
  }

  const write = new URL(req.url).searchParams.get("action") === "write";

  const client = await pool.connect();
  try {
    await client.query(`ALTER TABLE job_posts ADD COLUMN IF NOT EXISTS level text`);

    const { rows } = await client.query(
      `SELECT id, title, experience, source
       FROM job_posts
       WHERE first_seen >= NOW() - INTERVAL '30 days'`
    );

    const ids = [];
    const levels = [];
    const counts = {};
    for (const row of rows) {
      const level = computeLevel(row);
      counts[level] = (counts[level] || 0) + 1;
      ids.push(row.id);
      levels.push(level);
    }

    if (write && ids.length) {
      await client.query(
        `UPDATE job_posts jp
         SET level = v.level
         FROM (SELECT unnest($1::int[]) AS id, unnest($2::text[]) AS level) v
         WHERE jp.id = v.id`,
        [ids, levels]
      );
    }

    return new Response(
      JSON.stringify(
        {
          mode: write ? "write" : "dry-run",
          totalRows: rows.length,
          counts,
          sample: rows.slice(0, 15).map((r, i) => ({
            title: r.title,
            source: r.source,
            experience: r.experience,
            level: computeLevel(r),
          })),
        },
        null,
        2
      ),
      { headers: { "Content-Type": "application/json" } }
    );
  } finally {
    client.release();
  }
};
