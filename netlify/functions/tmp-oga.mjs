/*
  DISPOSABLE endpoint — delete after use.
  Created 2026-09-01: the ats-crawl SmartRecruiters rows were stored with the
  detail-response `applyUrl` (`…?oga=true`), which 302s to the /oneclick-ui/
  APPLICATION form instead of the job ad. _ats_providers.mjs now writes
  `postingUrl`; this rewrites the already-stored rows in place so the fix does
  not orphan them (url IS the row identity).
  Token hardcoded on purpose: single-use, removed in the same session.
*/
import { Pool } from "pg";

const TOKEN = "3f8a17c95e2b40d6ba71c0e4d938af52c61b7e09";
const CLEAN = `regexp_replace(url, '[?&]oga=true$', '')`;

const pool = new Pool({
  connectionString: process.env.NETLIFY_DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

export default async (req) => {
  const u = new URL(req.url);
  if (u.searchParams.get("t") !== TOKEN) return new Response("nope", { status: 403 });
  const action = u.searchParams.get("action") || "list";
  const client = await pool.connect();
  try {
    if (action === "list") {
      const r = await client.query(
        `SELECT source, url, ${CLEAN} AS clean_url, title, company, active, first_seen
           FROM job_posts
          WHERE url LIKE '%oga=true'
          ORDER BY source, active DESC, first_seen DESC`
      );
      const applied = await client.query(
        `SELECT job_key, applied, interview, applied_by FROM admin_applied_jobs WHERE job_key LIKE '%oga=true%'`
      ).catch((e) => ({ rows: [], error: e.message }));
      return json({ rowCount: r.rowCount, rows: r.rows, appliedKeys: applied.rows });
    }
    if (action === "strip") {
      // Same row, new url — the migrateVolatileUrl contract. Rows whose clean
      // url already exists in the same source are skipped (url is unique per
      // source), and reported so they can be looked at by hand.
      const r = await client.query(
        `UPDATE job_posts p
            SET url = ${CLEAN}
          WHERE p.url LIKE '%oga=true'
            AND NOT EXISTS (
                  SELECT 1 FROM job_posts q
                   WHERE q.source = p.source
                     AND q.url = regexp_replace(p.url, '[?&]oga=true$', '')
                )
        RETURNING p.source, p.url`
      );
      const left = await client.query(
        `SELECT source, url FROM job_posts WHERE url LIKE '%oga=true'`
      );
      return json({ migrated: r.rowCount, rows: r.rows, collisionsLeft: left.rows });
    }
    return json({ error: "unknown action" }, 400);
  } catch (e) {
    return json({ error: e.message }, 500);
  } finally {
    client.release();
  }
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}
