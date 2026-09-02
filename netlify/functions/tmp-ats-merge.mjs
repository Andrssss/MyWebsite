// Disposable one-off migration — merge cron_jobs_ATS-background's rows into
// ats-crawl (2026-09-02). Moves job_posts.source 'wise'/'roland' -> 'ats-crawl'.
// Delete after use per deploy-and-oneoff-writes-workflow.

import { Pool } from "pg";

const TOKEN = "b94c60bc5672e4ec5e2ae04478eb85e80298c4edec651ea4";

const connectionString = process.env.NETLIFY_DATABASE_URL;
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (token !== TOKEN) return new Response("Unauthorized", { status: 401 });

  const dryRun = new URL(request.url).searchParams.get("dryrun") === "1";

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Rows whose url would collide with an existing ats-crawl row: merge the
    // better fields into the ats-crawl row (COALESCE, never clobber a real
    // value), then drop the wise/roland duplicate.
    const conflicts = await client.query(`
      SELECT w.url, w.source AS old_source
      FROM job_posts w
      JOIN job_posts a ON a.source = 'ats-crawl' AND a.url = w.url
      WHERE w.source IN ('wise','roland')
    `);

    if (!dryRun && conflicts.rows.length > 0) {
      await client.query(`
        UPDATE job_posts a SET
          company = COALESCE(a.company, w.company),
          technologies = COALESCE(a.technologies, w.technologies),
          experience = CASE WHEN a.experience IS NULL OR a.experience IN ('-','')
                            THEN w.experience ELSE a.experience END
        FROM job_posts w
        WHERE a.source = 'ats-crawl' AND w.source IN ('wise','roland') AND a.url = w.url
      `);
      await client.query(`
        DELETE FROM job_posts w
        USING job_posts a
        WHERE w.source IN ('wise','roland') AND a.source = 'ats-crawl' AND a.url = w.url
      `);
    }

    // Non-conflicting rows: plain source rename.
    const renamed = dryRun
      ? await client.query(`
          SELECT url, source FROM job_posts w
          WHERE w.source IN ('wise','roland')
            AND NOT EXISTS (SELECT 1 FROM job_posts a WHERE a.source = 'ats-crawl' AND a.url = w.url)
        `)
      : await client.query(`
          UPDATE job_posts SET source = 'ats-crawl'
          WHERE source IN ('wise','roland')
          RETURNING url, source
        `);

    const remaining = await client.query(
      `SELECT source, COUNT(*)::int AS n FROM job_posts WHERE source IN ('wise','roland') GROUP BY source`
    );
    const atsCrawlTotal = await client.query(
      `SELECT COUNT(*)::int AS n FROM job_posts WHERE source = 'ats-crawl'`
    );

    if (dryRun) {
      await client.query("ROLLBACK");
    } else {
      await client.query("COMMIT");
    }

    return new Response(JSON.stringify({
      dryRun,
      conflictsFound: conflicts.rows.length,
      conflictUrls: conflicts.rows.map((r) => r.url),
      renamedCount: renamed.rows.length,
      remainingWiseRoland: remaining.rows,
      atsCrawlTotalAfter: atsCrawlTotal.rows[0].n,
    }, null, 2), { headers: { "content-type": "application/json" } });
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    return new Response(JSON.stringify({ error: err.message, stack: err.stack }, null, 2), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  } finally {
    client.release();
  }
};
