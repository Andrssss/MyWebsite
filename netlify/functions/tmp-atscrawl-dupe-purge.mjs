import { Pool } from "pg";

const TOKEN = "tmp-atscrawl-dupe-purge-956a22172f47f25080d6950b31f926c0866c781ebf87a2c7";

const pool = new Pool({
  connectionString: process.env.NETLIFY_DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// 2026-09-09: full-table dupeKey audit found these 3 ats-crawl rows duplicate
// an alllocaljobs row (title+company key match, confirmed by hand). Deleting
// the ats-crawl side rather than alllocaljobs's: ats-crawl's own cross-source
// dupe pre-filter (cron_jobs_ATSCRAWL-background.mjs) already checks against
// alllocaljobs on every future crawl, so removing the row here is durable —
// it will never re-insert itself. alllocaljobs has no equivalent check in the
// other direction, so deleting ITS copy instead would just have it reappear
// on alllocaljobs's own next scrape.
const IDS = [2125094, 2917278, 3091550];

export default async (req) => {
  const auth = req.headers.get("authorization") || "";
  if (auth.replace(/^Bearer\s+/i, "").trim() !== TOKEN) {
    return new Response("unauthorized", { status: 401 });
  }

  const client = await pool.connect();
  try {
    const res = await client.query(
      `DELETE FROM job_posts WHERE source = 'ats-crawl' AND id = ANY($1::int[]) RETURNING id, url, title`,
      [IDS]
    );
    return new Response(JSON.stringify({ deleted: res.rows }, null, 2), {
      headers: { "Content-Type": "application/json" },
    });
  } finally {
    client.release();
  }
};
