// netlify/functions/cron_linkedin_cleanup.mjs
// LinkedIn-only job_posts cleanup, split out of cron_jobposts_cleanup.mjs
// (2026-09-04, user request) because LinkedIn's cadence needs are different
// from every other source:
//
// LinkedIn never uses the active model (reconcileActive doesn't run on it,
// see _active_core.mjs / jobs.js TIME_BASED_SOURCES) — its rows stay
// active=true forever, so the monthly active=false-gated cleanup in
// cron_jobposts_cleanup.mjs would never catch them on its own; that file
// carries a LinkedIn-only, first_seen-based exception for exactly this
// reason. But running that exception only once a month (on the 1st) means a
// LinkedIn row that ages past its own 30-day cutoff right after a monthly
// run sits in the table for up to ~30 extra days before archival, even
// though the frontend already stopped showing it (jobs.js's first_seen
// window) and reviveSweepDead never touches LinkedIn either (excluded from
// SWEEP_EXCLUDED_SOURCES's self-heal window) — nothing is protecting that
// idle time. So LinkedIn gets its own tighter schedule instead; every other
// source stays on the monthly job, which is fine for them (60-day threshold
// with slack for reviveSweepDead's 45-day window).
//
// Runs every 2 days at 23:10 UTC — after EVERY scraper in the system, not
// just LinkedIn's own. Checked against every `config.schedule` in
// netlify/functions/: cron_scheduler.mjs (dispatches all ~25 non-LinkedIn
// scrapers) and cron_jobs_P.mjs both stop at hour 19 UTC; only the LinkedIn
// shards L_1..L_8 run into hour 20-22 UTC, and L_8 (self-scheduled at :28)
// is the latest-firing cron of any kind in the whole repo — 22:28 UTC.
// 23:10 UTC sits after that with margin, and before cron_daily_stats
// (23:59 UTC, though that only ever reads TODAY's first_seen rows so the
// ordering isn't load-bearing — kept anyway so nothing looks like it's
// racing the day's own scrape). See CRON_SCHEDULE.md for the full grid.
//
// Same archive-then-delete pattern, and the SAME "job-posts-archive" Blob
// store as cron_jobposts_cleanup.mjs — _stats_rebuild_core.mjs reads that
// store to rebuild history older than what's left in job_posts, so a
// LinkedIn row deleted here must land in the same place or old-day rebuilds
// would silently undercount LinkedIn.

import { getStore } from "@netlify/blobs";
import pkg from "pg";
const { Pool } = pkg;
import { withTimeout } from "./_error-logger.mjs";

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

const STORE_NAME = "job-posts-archive";
const SOURCE = "LinkedIn";
const ARCHIVE_AFTER_DAYS = 30;

export const config = {
  // "every 2 days" via odd days-of-month — not exactly 48h at month
  // boundaries (e.g. day 30 -> day 1 is a 2-day gap, day 31 -> day 1 is a
  // 1-day gap), same convention as everything else on this repo's crons.
  schedule: "10 23 */2 * *",
};

function budapestDateHourStamp() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Budapest",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}-${get("hour")}`;
}

export default withTimeout("cron_linkedin_cleanup", async function handler() {
  const client = await pool.connect();
  try {
    const { rows: oldPosts } = await client.query(
      `SELECT * FROM job_posts
        WHERE source = $1
          AND first_seen < NOW() - make_interval(days => $2::int)
        ORDER BY first_seen`,
      [SOURCE, ARCHIVE_AFTER_DAYS]
    );

    if (oldPosts.length === 0) {
      console.log(
        `[linkedin_cleanup] Nincs ${ARCHIVE_AFTER_DAYS} napnál régebbi LinkedIn sor, kihagyva.`
      );
      return;
    }

    const key = `job-posts-archive-linkedin-${budapestDateHourStamp()}.json`;
    const store = getStore(STORE_NAME);

    await store.set(
      key,
      JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          source: SOURCE,
          archiveAfterDays: ARCHIVE_AFTER_DAYS,
          count: oldPosts.length,
          rows: oldPosts,
        },
        null,
        2
      ),
      { metadata: { type: "job-posts-archive", source: SOURCE, count: oldPosts.length } }
    );

    const urls = oldPosts.map((r) => r.url);

    const { rowCount: deleted } = await client.query(
      `DELETE FROM job_posts WHERE source = $1 AND url = ANY($2::text[])`,
      [SOURCE, urls]
    );

    console.log(
      `[linkedin_cleanup] Archived to ${key}: ${oldPosts.length} rows. Deleted: ${deleted}`
    );
  } finally {
    client.release();
  }
});
