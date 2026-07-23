/**
 * ONE-OFF backfill — sets job_posts.hidden = true for every row whose url
 * matches an admin_applied_jobs entry with applied = true, so already-applied
 * jobs retroactively drop off the public board (see job-applied.js, which now
 * mirrors this going forward on every applied-toggle).
 *
 * NO schedule → only runs when triggered manually via HTTP. Delete this file
 * after running it once.
 *
 * Trigger:
 *   curl -X POST -H "Authorization: Bearer $CRON_SECRET" \
 *        https://<your-site>/.netlify/functions/backfill-hidden-applied
 */

import pkg from "pg";
const { Pool } = pkg;

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

export default async (request) => {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get("authorization") || "";

  if (!secret || auth !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    await pool.query(
      `ALTER TABLE job_posts ADD COLUMN IF NOT EXISTS hidden boolean NOT NULL DEFAULT false`
    );

    const { rows } = await pool.query(
      `UPDATE job_posts
          SET hidden = true
        WHERE hidden = false
          AND url IN (
            SELECT job_data->>'url'
              FROM admin_applied_jobs
             WHERE applied = true
               AND job_data->>'url' IS NOT NULL
          )
        RETURNING id, source, title, url`
    );

    const msg = `[backfill-hidden-applied] hid ${rows.length} row(s): ${JSON.stringify(
      rows.map((r) => ({ id: r.id, source: r.source, title: r.title }))
    )}`;
    console.log(msg);
    return new Response(msg, { status: 200 });
  } catch (err) {
    console.error("[backfill-hidden-applied] failed:", err);
    return new Response(`Error: ${err.message}`, { status: 500 });
  }
};
