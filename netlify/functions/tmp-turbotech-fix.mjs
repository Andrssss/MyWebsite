// DISPOSABLE — 2026-09-10. Inspect + fix job_posts id 2337889 (Turbo Tech
// Hungary, "Beágyazott szoftver- és/vagy hardverfejlesztő"): experience was
// wrongly stored as "diákmunka" (the source page never contains that word at
// all — it only says the role "gyakornokként is" fillable, alongside being a
// real embedded dev position with Java/C++/C#/.NET/Azure requirements).
// GET returns current row (diagnostic, no write). POST applies the fix.
// Delete after use.
import { Pool } from "pg";

const TOKEN = "b3f8a1d7c94e206b5a8f9c31e7d40b62958a4c1073de";
const connectionString = process.env.NETLIFY_DATABASE_URL;
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });
const ID = 2337889;

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });

  const client = await pool.connect();
  try {
    if (request.method === "POST") {
      const { rows } = await client.query(
        `UPDATE job_posts SET experience = '' WHERE id = $1 AND experience = 'diákmunka'
          RETURNING id, url, title, company, active, experience, technologies`,
        [ID]
      );
      return new Response(JSON.stringify({ updated: rows.length, rows }, null, 2), { headers: { "content-type": "application/json" } });
    }
    const diak = await client.query(
      `SELECT id, url, title, company, active, technologies FROM job_posts
        WHERE source = 'AI-scraped' AND experience = 'diákmunka' ORDER BY id`
    );
    return new Response(JSON.stringify({ count: diak.rows.length, rows: diak.rows }, null, 2), { headers: { "content-type": "application/json" } });
  } finally {
    client.release();
  }
};
