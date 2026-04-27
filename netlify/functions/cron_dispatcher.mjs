export const config = {
  schedule: "17 6-22 * * *",
};

import { withTimeout } from "./_error-logger.mjs";

/**
 * Unified cron dispatcher.
 *
 * Triggers all consolidated background workers in parallel via HTTP POST.
 * Each background function gets the 15 min Netlify limit and runs
 * independently — keeping its own scraping logic intact.
 *
 * Targets:
 *   A_K, BLUE, C_1, C_2, DIAK_1, DIAK_2, DIAK_3, F_3, MIX, T
 */
const TARGETS = [
  { name: "cron_jobs_A_K-background" },
  { name: "cron_jobs_BLUE-background" },
  { name: "cron_jobs_C_1-background" },
  { name: "cron_jobs_C_2-background" },
  { name: "cron_jobs_DIAK_1-background" },
  { name: "cron_jobs_DIAK_2-background" },
  { name: "cron_jobs_DIAK_3-background" },
  { name: "cron_jobs_F_3-background", body: { startPage: 1 } },
  { name: "cron_jobs_MIX-background" },
  { name: "cron_jobs_T-background" },
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
