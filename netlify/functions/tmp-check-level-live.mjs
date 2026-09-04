// Disposable read-only check: did new job_posts rows since deploy get `level`?
import { Pool } from "pg";

const TOKEN = "tmp-level-live-check-91ac4d7e";

const pool = new Pool({
  connectionString: process.env.NETLIFY_DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

export default async (req) => {
  const auth = req.headers.get("authorization") || "";
  if (auth.replace(/^Bearer\s+/i, "").trim() !== TOKEN) {
    return new Response("unauthorized", { status: 401 });
  }

  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT id, source, title, experience, level, first_seen
       FROM job_posts
       ORDER BY first_seen DESC
       LIMIT 20`
    );
    const nullCount = await client.query(
      `SELECT COUNT(*)::int AS c FROM job_posts WHERE first_seen >= NOW() - INTERVAL '2 hours' AND level IS NULL`
    );
    return new Response(
      JSON.stringify({ latest: rows, nullLevelLast2h: nullCount.rows[0].c }, null, 2),
      { headers: { "Content-Type": "application/json" } }
    );
  } finally {
    client.release();
  }
};
