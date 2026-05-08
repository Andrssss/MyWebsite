export const config = {
  schedule: "15 4-22 * * *",
};

import { withTimeout } from "./_error-logger.mjs";

/**
 * TEMP cron dispatcher — testing subset of background workers.
 *
 * Triggers selected background functions in parallel via HTTP POST.
 * Same mechanics as cron_dispatcher.mjs.
 */
const TARGETS = [
  { name: "cron_jobs_MBH-background" },
  { name: "cron_jobs_KH-background" },
  { name: "cron_jobs_RAIFFEISEN-background" },
  { name: "cron_jobs_ERSTE-background" },
  { name: "cron_jobs_MFB-background" },
  { name: "cron_jobs_UNICREDIT-background" },
  { name: "cron_jobs_CG-background" },
  { name: "cron_jobs_ATS-background" },
  { name: "cron_jobs_EUDIAKOK-background" },
  { name: "cron_jobs_MELODIAK-background" },
  { name: "cron_jobs_ATLASZ-background" },
  { name: "cron_jobs_PANNONDIAK-background" },
];

export default withTimeout("cron_dispatcher_test", async () => {
  const siteUrl = process.env.URL;
  const secret = process.env.CRON_SECRET;

  if (!siteUrl || !secret) {
    console.warn("[cron_dispatcher_test] URL or CRON_SECRET not set, cannot trigger background functions");
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
        .then(() => console.log(`[cron_dispatcher_test] triggered ${task.name}`))
        .catch((err) => console.error(`[cron_dispatcher_test] failed to trigger ${task.name}: ${err.message}`))
    )
  );

  return new Response(`Triggered ${TARGETS.length} background invocations`, { status: 200 });
});
