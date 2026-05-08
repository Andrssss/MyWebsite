export const config = {
  schedule: "25 4-22 * * *",
};

import { withTimeout } from "./_error-logger.mjs";

/**
 * TEMP cron dispatcher — új scraper sources tesztelése.
 *
 * Targets: euDiákok, MelóDiák, Atlasz, PannonDiák, Valore Basis, Trenkwalder, WorkCenter
 */
const TARGETS = [
//   { name: "cron_jobs_EUDIAKOK-background" },
//   { name: "cron_jobs_MELODIAK-background" },
  { name: "cron_jobs_ATLASZ-background" },
//   { name: "cron_jobs_PANNONDIAK-background" },
//   { name: "cron_jobs_VALOREBASIS-background" },
//   { name: "cron_jobs_TRENKWALDER-background" },
//   { name: "cron_jobs_WORKCENTER-background" },
];

export default withTimeout("cron_dispatcher_new_sources", async () => {
  const siteUrl = process.env.URL;
  const secret = process.env.CRON_SECRET;

  if (!siteUrl || !secret) {
    console.warn("[cron_dispatcher_new_sources] URL or CRON_SECRET not set, cannot trigger background functions");
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
        .then(() => console.log(`[cron_dispatcher_new_sources] triggered ${task.name}`))
        .catch((err) => console.error(`[cron_dispatcher_new_sources] failed to trigger ${task.name}: ${err.message}`))
    )
  );

  return new Response(`Triggered ${TARGETS.length} background invocations`, { status: 200 });
});
