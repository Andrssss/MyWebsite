import { Pool } from "pg";

const TOKEN = "tmp-talent-fix-2rows-17c6caf1737a3a6db4a1e55b04f9256ebaf1daf0f1f967dd";

const pool = new Pool({
  connectionString: process.env.NETLIFY_DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// 2026-09-09 full cross-source liveness audit findings for `talent`, each
// independently confirmed (own url status + cross-checked against the
// current active list for title duplicates before acting):
const DEACTIVATE = [
  "https://hu.talent.com/view?id=614830699691049684", // 410
  "https://hu.talent.com/view?id=632710894651774597", // 404
];
// Reactivate only the 3 of 9 stale "false OFF" rows with NO active duplicate
// under a different id (talent's ids are known to rotate on rescrape) and no
// near-duplicate risk against the "AI Research Engineer" title-template
// family already active. The other 6 were deliberately left alone.
const REACTIVATE = [
  "https://hu.talent.com/view?id=607314259769633911", // MS Dynamics 365 Customer Engagement (CRM) fejlesztő
  "https://hu.talent.com/view?id=622150282688142340", // Enterprise Server Infrastructure Engineer
  "https://hu.talent.com/view?id=623862799464269893", // Infrastructure Verification Engineer
];

export default async (req) => {
  const auth = req.headers.get("authorization") || "";
  if (auth.replace(/^Bearer\s+/i, "").trim() !== TOKEN) {
    return new Response("unauthorized", { status: 401 });
  }

  const client = await pool.connect();
  try {
    const dead = await client.query(
      `UPDATE job_posts
          SET active = false, sweep_dead = true
        WHERE source = 'talent'
          AND active = true
          AND url = ANY($1::text[])
        RETURNING url`,
      [DEACTIVATE]
    );
    const revived = await client.query(
      `UPDATE job_posts
          SET active = true, sweep_dead = false
        WHERE source = 'talent'
          AND active = false
          AND url = ANY($1::text[])
        RETURNING url`,
      [REACTIVATE]
    );
    return new Response(
      JSON.stringify({ deactivated: dead.rows.map((r) => r.url), reactivated: revived.rows.map((r) => r.url) }, null, 2),
      { headers: { "Content-Type": "application/json" } }
    );
  } finally {
    client.release();
  }
};
