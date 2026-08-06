// Disposable one-off endpoint (2026-08-06): carve "UX/UI Design" out as its
// own category — design keywords ("figma", "ux designer", "product designer",
// ...) were previously mixed into "Webfejlesztés", miscategorizing designers
// as web developers. Moves the design keywords out of Webfejlesztés into a
// new category with an initial technologies[] mapping. Deploy -> invoke -> delete.
import { Pool } from "pg";

const connectionString = process.env.NETLIFY_DATABASE_URL;
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

const TOKEN = "add-ux-cat-3f7d1a9e6c4b8025";

const DESIGN_KEYWORDS = [
  "design system", "figma", "interaction design", "product designer",
  "ui designer", "ui/ux", "user experience", "user interface",
  "ux designer", "ux engineer", "ux/ui", "web design", "Web Designer",
  "product design", "designer",
];
const DESIGN_TECHNOLOGIES = ["Figma", "Adobe XD"];

export default async (req) => {
  const hdr = req.headers.get("authorization") || "";
  const token = hdr.replace(/^Bearer\s+/i, "").trim();
  if (token !== TOKEN) {
    return new Response("Unauthorized", { status: 401 });
  }

  const client = await pool.connect();
  try {
    await client.query(
      `ALTER TABLE job_categories ADD COLUMN IF NOT EXISTS technologies text[] NOT NULL DEFAULT '{}'`
    );

    const trimmed = await client.query(
      `UPDATE job_categories
       SET keywords = (SELECT array_agg(k) FROM unnest(keywords) AS k WHERE NOT (k = ANY($1)))
       WHERE name = 'Webfejlesztés'
       RETURNING id, name, keywords`,
      [DESIGN_KEYWORDS]
    );

    const inserted = await client.query(
      `INSERT INTO job_categories (name, keywords, technologies)
       VALUES ('UX/UI Design', $1, $2)
       ON CONFLICT (name) DO UPDATE SET keywords = EXCLUDED.keywords, technologies = EXCLUDED.technologies
       RETURNING id, name, keywords, technologies`,
      [DESIGN_KEYWORDS, DESIGN_TECHNOLOGIES]
    );

    return new Response(
      JSON.stringify({ webfejlesztesTrimmed: trimmed.rows[0], uxCategory: inserted.rows[0] }, null, 2),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  } finally {
    client.release();
  }
};
