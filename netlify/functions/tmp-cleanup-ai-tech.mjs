// Disposable one-off endpoint (2026-08-06): apply the curated technologies
// cleanup for source=AI-scraped rows. Body: [[url, oldTech, newTech], ...].
// Guarded by oldTech so a row only updates if its technologies field still
// matches what was analyzed (no clobbering concurrent AI-registry writes).
// Deploy -> invoke -> delete this file.
import { Pool } from "pg";

const connectionString = process.env.NETLIFY_DATABASE_URL;
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

const TOKEN = "ai-tech-cleanup-4e8b1a7f2d9c6053";

export default async (req) => {
  const hdr = req.headers.get("authorization") || "";
  const token = hdr.replace(/^Bearer\s+/i, "").trim();
  if (token !== TOKEN) {
    return new Response("Unauthorized", { status: 401 });
  }

  const rows = await req.json();
  if (!Array.isArray(rows)) {
    return new Response("Expected an array", { status: 400 });
  }

  const client = await pool.connect();
  try {
    let updated = 0;
    let skipped = 0;
    for (const [url, oldTech, newTech] of rows) {
      const result = await client.query(
        `UPDATE job_posts SET technologies = $1
         WHERE source = 'AI-scraped' AND url = $2 AND technologies = $3`,
        [newTech, url, oldTech]
      );
      if (result.rowCount > 0) updated++;
      else skipped++;
    }
    return new Response(JSON.stringify({ total: rows.length, updated, skipped }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } finally {
    client.release();
  }
};
