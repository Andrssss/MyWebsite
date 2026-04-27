export const config = {
  schedule: "1 6-22 * * *",
};

import { withTimeout } from "./_error-logger.mjs";

/**
 * Unified Profession dispatcher.
 *
 * Each task scrapes one Profession.hu listing URL.
 * Tasks with `split` are sliced into N background invocations of `pagesPerSplit`
 * pages each (used for large categories that need parallelism).
 * Tasks without `split` run as a single background invocation with default paging.
 *
 * All background invocations are fired in parallel — they execute independently
 * on Netlify Background Functions (15 min limit each).
 */
const TASKS = [
  {
    jobName: "P_1",
    url: "https://www.profession.hu/allasok/it-programozas-fejlesztes/budapest/1,10,23",
    split: 2,
    pagesPerSplit: 15,
  },
  {
    jobName: "P_2",
    url: "https://www.profession.hu/allasok/it-uzemeltetes-telekommunikacio/budapest/1,25,23,gyakornok",
  },
  {
    jobName: "P_3",
    url: "https://www.profession.hu/allasok/adatbazisszakerto/budapest/1,10,23,0,200",
  },
  {
    jobName: "P_4",
    url: "https://www.profession.hu/allasok/programozo-fejleszto/budapest/1,10,23,0,75",
    split: 2,
    pagesPerSplit: 15,
  },
  {
    jobName: "P_5",
    url: "https://www.profession.hu/allasok/tesztelo-tesztmernok/budapest/1,10,23,0,80",
  },
  {
    jobName: "P_6",
    url: "https://www.profession.hu/allasok/it-programozas-fejlesztes/budapest/1,10,23,intern",
  },
];

function buildInvocations(tasks) {
  const invocations = [];
  for (const task of tasks) {
    if (task.split && task.split > 1) {
      const per = task.pagesPerSplit || 15;
      for (let i = 0; i < task.split; i++) {
        invocations.push({
          jobName: task.jobName,
          url: task.url,
          startPage: 1 + i * per,
          maxPages: per,
          suffix: String.fromCharCode(97 + i), // a, b, c...
        });
      }
    } else {
      invocations.push({
        jobName: task.jobName,
        url: task.url,
      });
    }
  }
  return invocations;
}

export default withTimeout("cron_jobs_P", async () => {
  const siteUrl = process.env.URL;
  const secret = process.env.CRON_SECRET;

  if (!siteUrl || !secret) {
    console.warn("[cron_jobs_P] URL or CRON_SECRET not set, cannot trigger background functions");
    return new Response("Missing env vars", { status: 500 });
  }

  const invocations = buildInvocations(TASKS);

  await Promise.all(
    invocations.map((inv) => {
      const label = inv.suffix
        ? `${inv.jobName}-${inv.suffix} (pages ${inv.startPage}-${inv.startPage + inv.maxPages - 1})`
        : inv.jobName;

      return fetch(`${siteUrl}/.netlify/functions/cron_jobs_P-background`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(inv),
      })
        .then(() => console.log(`[cron_jobs_P] triggered ${label}`))
        .catch((err) => console.error(`[cron_jobs_P] failed to trigger ${label}: ${err.message}`));
    })
  );

  return new Response(`Triggered ${invocations.length} background invocations`, { status: 200 });
});
