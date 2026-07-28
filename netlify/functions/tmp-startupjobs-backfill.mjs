// TEMPORARY one-off endpoint — inserts the pre-scraped historical startup.jobs
// backfill rows into job_posts. Deployed, invoked once, then deleted. Do not
// leave this in the repo; if you're reading this later and it's still here,
// it should have been removed right after use (see conversation history).
import { Pool } from "pg";

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });
const ONE_OFF_TOKEN = "9fb63a3460acbd244576c7d47b50951d2fd033c89b356dbe";

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (token !== ONE_OFF_TOKEN) return new Response("Unauthorized", { status: 401 });

  const rows = await request.json();
  if (!Array.isArray(rows)) return new Response("bad body", { status: 400 });

  const client = await pool.connect();
  let inserted = 0, skipped = 0;
  try {
    for (const r of rows) {
      const res = await client.query(
        `INSERT INTO job_posts (source, title, url, experience, company, technologies, first_seen)
         VALUES ('startupjobs',$1,$2,$3,$4,$5,NOW())
         ON CONFLICT (source, url) DO NOTHING
         RETURNING id;`,
        [r.title, r.url, r.experience ?? "-", r.company ?? null, r.technologies ?? null]
      );
      if (res.rowCount > 0) inserted++; else skipped++;
    }
  } finally {
    client.release();
  }
  return new Response(JSON.stringify({ inserted, skipped }), { status: 200 });
};
