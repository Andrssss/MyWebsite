export const config = {
  schedule: "22 6-22 * * *",
};

import { withTimeout } from "./_error-logger.mjs";

export default withTimeout("cron_jobs_P_4", async () => {
  const siteUrl = process.env.URL;
  const secret = process.env.CRON_SECRET;

  if (!siteUrl || !secret) {
    console.warn("[cron_jobs_P_4] URL or CRON_SECRET not set, cannot trigger background functions");
    return new Response("Missing env vars", { status: 500 });
  }

  // Trigger both halves in parallel — each ~15 pages × 30s = ~7.5 min (well within 15 min limit)
  const triggers = [
    { suffix: "a", startPage: 1,  maxPages: 15 },
    { suffix: "b", startPage: 16, maxPages: 15 },
  ];

  await Promise.all(
    triggers.map(({ suffix, startPage, maxPages }) =>
      fetch(`${siteUrl}/.netlify/functions/cron_jobs_P_4-background`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ startPage, maxPages }),
      })
        .then(() => console.log(`[cron_jobs_P_4] triggered background ${suffix} (pages ${startPage}-${startPage + maxPages - 1})`))
        .catch((err) => console.error(`[cron_jobs_P_4] failed to trigger background ${suffix}: ${err.message}`))
    )
  );

  return new Response("Background functions triggered", { status: 200 });
});
