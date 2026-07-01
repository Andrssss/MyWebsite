export const config = {
  schedule: "55 4-22 * * *",
};

import { withTimeout } from "./_error-logger.mjs";

/**
 * Unified cron dispatcher.
 *
 * Triggers all consolidated background workers in parallel via HTTP POST.
 * Each background function gets the 15 min Netlify limit and runs
 * independently — keeping its own scraping logic intact.
 *
 * Hourly targets (≥10 active, or mixed scrapers):
 *   BLUE, DIAK_1, DIAK_2, DIAK_3, F_3, MIX, OTP, T, VALOREBASIS, NOFLUFFJOBS,
 *   ERSTE, KH, RAIFFEISEN
 *
 * Elsewhere: MBH (cron_dispatcher_test); low-volume <10 single-source scrapers
 * (A_K, CG, ATS, MFB, UNICREDIT, EUDIAKOK, MELODIAK, ATLASZ, PANNONDIAK,
 * TRENKWALDER, WORKCENTER) run once/day via cron_dispatcher_daily; P, L_1..L_11.
 */
// Hourly targets: sources with ≥10 active postings, or mixed scrapers that also
// feed a large source. Low-volume single-source scrapers (all <10) run once/day
// via cron_dispatcher_daily.mjs instead.
const TARGETS = [
  { name: "cron_jobs_BLUE-background" },
  { name: "cron_jobs_DIAK_1-background" },
  { name: "cron_jobs_DIAK_2-background" },
  { name: "cron_jobs_DIAK_3-background" },
  { name: "cron_jobs_F_3-background", body: { startPage: 1 } },
  { name: "cron_jobs_MIX-background" },
  { name: "cron_jobs_OTP-background" },
  { name: "cron_jobs_T-background" },
  { name: "cron_jobs_VALOREBASIS-background" },
  { name: "cron_jobs_NOFLUFFJOBS-background" },
  // Re-added 2026-07-01: these had silently dropped out of every dispatcher, so
  // they stopped running entirely (no inserts, no active-reconcile) and their
  // job_posts froze at 100% active. Only the ≥10 banks stay hourly.
  { name: "cron_jobs_ERSTE-background" },
  { name: "cron_jobs_KH-background" },
  { name: "cron_jobs_RAIFFEISEN-background" },
];

export default withTimeout("cron_dispatcher", async () => {
  const siteUrl = process.env.URL;
  const secret = process.env.CRON_SECRET;

  if (!siteUrl || !secret) {
    console.warn("[cron_dispatcher] URL or CRON_SECRET not set, cannot trigger background functions");
    return new Response("Missing env vars", { status: 500 });
  }

  await Promise.all(
    TARGETS.map((task) =>
      fetch(`${siteUrl}/.netlify/functions/${task.name}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(task.body ?? {}),
      })
        .then(() => console.log(`[cron_dispatcher] triggered ${task.name}`))
        .catch((err) => console.error(`[cron_dispatcher] failed to trigger ${task.name}: ${err.message}`))
    )
  );

  return new Response(`Triggered ${TARGETS.length} background invocations`, { status: 200 });
});
