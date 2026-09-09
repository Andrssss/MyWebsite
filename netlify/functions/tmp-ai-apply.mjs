// DISPOSABLE apply endpoint — 2026-09-09. Deletes the ONE confirmed
// cross-source duplicate found by two independent tmp-ai-audit-background
// runs (id 2811254, AI-scraped "Embedded Software Engineer" / Silicon Labs,
// duplicates an active alllocaljobs row). No liveness flips were applied —
// the one deactivate candidate the first audit run found was re-checked and
// confirmed to be a transient blip on the source site, not a real death (it
// disappeared on the second independent run and on manual re-checks).
// Delete after use.
import { Pool } from "pg";

const TOKEN = "763f13e6df929c214d0fdd59a54d83098c16151213335d01";
const connectionString = process.env.NETLIFY_DATABASE_URL;
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });

  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `DELETE FROM job_posts
        WHERE id = 2811254 AND source = 'AI-scraped'
          AND company = 'Silicon Labs' AND title = 'Embedded Software Engineer'
        RETURNING id, url, title, company`
    );
    return new Response(JSON.stringify({ deleted: rows.length, rows }, null, 2), {
      headers: { "content-type": "application/json" },
    });
  } finally {
    client.release();
  }
};
