/*
  AI-scraped + ats-crawl only, extra 404/AI-liveness sweep (2026-09-08, user
  request): "AI és ATS munkák deaktiválása" — deactivation ONLY, nothing else
  (no archive, no cleanup/delete — that's a separate concern the user
  explicitly declined here).

  This is deliberately ADDITIONAL to, not a replacement for, the general
  cron_404sweep-background.mjs (daily, every source): the user chose to accept
  the redundant HTTP traffic on these two sources rather than pull them out of
  the daily sweep. Same sweepActive404 (_active_core.mjs), same checkFinal
  (fetchFinal from cron_404sweep-background.mjs — one implementation, not a
  second hand-copied fetch), same platform-specific death rules
  (BANNER_DEAD_SOURCES / SWEEP_PROBE_OVERRIDES "AI-scraped" / "ats-crawl" →
  aiScrapedIsDead / aiScrapedProbe, which ask each posting's OWN Greenhouse /
  Lever / Ashby / SmartRecruiters / Workday job API) — just scoped to these
  two sources via sweepActive404's `onlySources` option, and on its own
  2-day cadence instead of daily.

  No revive (reviveSweepDead) here — that's the daily sweep's job, and running
  it twice on the same sweep_dead rows would just be wasted work; nothing about
  the revive side is source-scoped in a way this file would change.
*/

export const config = {
  // "every 2 days" via odd days-of-month (day 30→1 is a 2-day gap, 31→1 a
  // 1-day gap) — same convention cron_linkedin_cleanup.mjs uses. Noon UTC:
  // clear of the 23:xx end-of-day cluster (cron_dupe_snapshot 23:45,
  // cron_daily_stats 23:59, cron_linkedin_cleanup 23:10) and of the 14:00
  // daily dispatcher that already runs the general sweep on these sources.
  schedule: "0 12 */2 * *",
};

import { Pool } from "pg";
import { withTimeout } from "./_error-logger.mjs";
import { sweepActive404 } from "./_active_core.mjs";
import { fetchFinal } from "./cron_404sweep-background.mjs";
import { AI_SOURCE } from "./_ai_ingest_core.mjs";

// Mirrors cron_jobs_ATSCRAWL-background.mjs's ATS_SOURCE constant — not
// imported from there directly to avoid pulling in that file's own top-level
// DB pool just for a string.
const ATS_SOURCE = "ats-crawl";

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

export default withTimeout("cron_ai_ats_deactivate-background", async () => {
  const client = await pool.connect();
  try {
    const rc = await sweepActive404(client, fetchFinal, { onlySources: [AI_SOURCE, ATS_SOURCE] });
    console.log(`[ai_ats_deactivate] ${JSON.stringify(rc)}`);
  } finally {
    client.release();
  }
});
