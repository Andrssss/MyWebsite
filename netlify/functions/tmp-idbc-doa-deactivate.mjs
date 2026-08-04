// Disposable one-off: deactivate the 2 alllocaljobs rows inserted 2026-08-04
// that were already dead on arrival (search-index lag bug, fixed in
// cron_jobs_ALLLOCALJOBS-background.mjs same day — this only cleans up the
// 2 rows that slipped in before the fix deployed). Delete after use.

import { Pool } from "pg";

const connectionString = process.env.NETLIFY_DATABASE_URL;
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

const TOKEN = "950b7a58b9ca300d478660de9bd5438fe216df1fb6fff67e";

const URLS = [
  "https://hu.alllocaljobs.com/%C3%A1ll%C3%A1s-vWt5wxZAV",
  "https://hu.alllocaljobs.com/%C3%A1ll%C3%A1s-dyt723z7b",
];

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (token !== TOKEN) return new Response("Unauthorized", { status: 401 });

  const client = await pool.connect();
  try {
    const res = await client.query(
      `UPDATE job_posts SET active = false
        WHERE source = 'alllocaljobs' AND url = ANY($1::text[])
        RETURNING url, title, active`,
      [URLS]
    );
    return new Response(JSON.stringify(res.rows), { headers: { "Content-Type": "application/json" } });
  } finally {
    client.release();
  }
};
