export const config = {
  schedule: "19 4-23 * * *",
};

import { withTimeout } from "./_error-logger.mjs";

export default withTimeout("cron_jobs_F_3", async () => {
  const siteUrl = process.env.URL;
  const secret = process.env.CRON_SECRET;

  if (!siteUrl || !secret) {
    console.warn("[cron_jobs_F_3] URL or CRON_SECRET not set, cannot trigger background function");
    return new Response("Missing env vars", { status: 500 });
  }

  await fetch(`${siteUrl}/.netlify/functions/cron_jobs_F_3-background`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ startPage: 1 }),
  })
    .then(() => console.log("[cron_jobs_F_3] triggered background (pages 1–∞)"))
    .catch((err) => console.error(`[cron_jobs_F_3] failed to trigger background: ${err.message}`));

  return new Response("Background function triggered", { status: 200 });
});
