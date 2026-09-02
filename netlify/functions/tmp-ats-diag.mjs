// Disposable diagnostic endpoint — "ma nem talált semmit" (2026-09-02).
// Read-only. Delete after use per deploy-and-oneoff-writes-workflow.

import { Pool } from "pg";

const TOKEN = "e903333ec1392102e57b51bcf9089a0be179f64db9dfbf99";

const connectionString = process.env.NETLIFY_DATABASE_URL;
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (token !== TOKEN) return new Response("Unauthorized", { status: 401 });

  const client = await pool.connect();
  try {
    const now = await client.query(`SELECT NOW() AS now`);

    const tenantSummary = await client.query(`
      SELECT status, COUNT(*)::int AS n, MAX(last_checked) AS max_last_checked
      FROM ats_tenants GROUP BY status ORDER BY n DESC
    `);

    const recentRuns = await client.query(`
      SELECT provider, slug, company, status, last_checked, last_hu_count, hit_count, last_error
      FROM ats_tenants
      ORDER BY last_checked DESC NULLS LAST
      LIMIT 30
    `);

    const staleLive = await client.query(`
      SELECT provider, slug, company, status, last_checked, last_hu_count, hit_count, last_error
      FROM ats_tenants
      WHERE status = 'live' AND (last_checked IS NULL OR last_checked < NOW() - INTERVAL '2 hours')
      ORDER BY last_checked ASC NULLS FIRST
      LIMIT 30
    `);

    const withErrors = await client.query(`
      SELECT provider, slug, company, status, last_checked, last_error
      FROM ats_tenants
      WHERE last_error IS NOT NULL
      ORDER BY last_checked DESC NULLS LAST
      LIMIT 20
    `);

    const jobPostsToday = await client.query(`
      SELECT COUNT(*)::int AS n
      FROM job_posts
      WHERE source = 'ats-crawl' AND first_seen >= date_trunc('day', NOW())
    `);

    const jobPostsActive = await client.query(`
      SELECT COUNT(*)::int AS n FROM job_posts WHERE source = 'ats-crawl' AND active = true
    `);

    const lastInsert = await client.query(`
      SELECT MAX(first_seen) AS max_first_seen
      FROM job_posts WHERE source = 'ats-crawl'
    `);

    return new Response(JSON.stringify({
      now: now.rows[0].now,
      tenantSummary: tenantSummary.rows,
      recentRuns: recentRuns.rows,
      staleLiveTenants: staleLive.rows,
      tenantsWithErrors: withErrors.rows,
      jobPostsInsertedToday: jobPostsToday.rows[0].n,
      jobPostsActiveTotal: jobPostsActive.rows[0].n,
      lastEverInsert: lastInsert.rows[0].max_first_seen,
    }, null, 2), { headers: { "content-type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message, stack: err.stack }, null, 2), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  } finally {
    client.release();
  }
};
