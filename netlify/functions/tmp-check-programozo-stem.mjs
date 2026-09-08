// Disposable read-only check: does `job_categories` already store the
// "programozó"/"webfejlesztő" family as `~`-stem keywords (STEM_PREFIX,
// src/lib/categorize.mjs), or only as bare dictionary-form keywords that
// miss inflected titles like "Programozót, webfejlesztőt keresünk!"?
// Read-only. No writes performed. Delete after use.
import { Pool } from "pg";

const TOKEN = "tmp-check-programozo-stem-964e24072a0dfc78d33c9874e4317f59";

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
      `SELECT id, name, keywords FROM job_categories ORDER BY id`
    );

    const hits = [];
    for (const r of rows) {
      const matching = (r.keywords || []).filter((k) =>
        /programoz|fejleszt/i.test(String(k))
      );
      if (matching.length) hits.push({ id: r.id, name: r.name, matching });
    }

    return new Response(JSON.stringify({ hits }, null, 2), {
      headers: { "content-type": "application/json" },
    });
  } finally {
    client.release();
  }
};
