import { Pool } from "pg";

const TOKEN = "tmp-ats-ai-audit-dump-b16c5de49befa0d14acd999be749e2f1a92f11898d06e164";

const pool = new Pool({
  connectionString: process.env.NETLIFY_DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// 2026-09-09: read-only dump for a full AI-scraped + ats-crawl cleanup pass
// (liveness + cross-source + same-source duplicates). audit-data.mjs doesn't
// expose `company`, which duplicate detection needs, so this is a dedicated
// disposable read.
export default async (req) => {
  const auth = req.headers.get("authorization") || "";
  if (auth.replace(/^Bearer\s+/i, "").trim() !== TOKEN) {
    return new Response("unauthorized", { status: 401 });
  }

  const client = await pool.connect();
  try {
    const target = await client.query(
      `SELECT id, source, url, title, company, technologies, active, sweep_dead,
              first_seen
         FROM job_posts
        WHERE source IN ('AI-scraped', 'ats-crawl')
        ORDER BY id`
    );
    const others = await client.query(
      `SELECT source, url, title, company, active
         FROM job_posts
        WHERE source NOT IN ('AI-scraped', 'ats-crawl')
          AND company IS NOT NULL AND company <> ''
          AND title IS NOT NULL AND title <> ''`
    );
    return new Response(
      JSON.stringify({ target: target.rows, others: others.rows }),
      { headers: { "Content-Type": "application/json" } }
    );
  } finally {
    client.release();
  }
};
