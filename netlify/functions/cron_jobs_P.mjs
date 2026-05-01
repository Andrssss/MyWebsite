export const config = {
  schedule: "1 5-22 * * *",
};

import { withTimeout } from "./_error-logger.mjs";

/**
 * Unified Profession dispatcher.
 *
 * Each task scrapes one Profession.hu listing URL via a single background
 * invocation. Background functions have a 15 min limit, which is enough for
 * full pagination of any single listing.
 */
const TASKS = [
  { jobName: "P_1", url: "https://www.profession.hu/allasok/it-programozas-fejlesztes/budapest/1,10,23" },
  { jobName: "P_2", url: "https://www.profession.hu/allasok/it-uzemeltetes-telekommunikacio/budapest/1,25,23,gyakornok" },
  { jobName: "P_3", url: "https://www.profession.hu/allasok/adatbazisszakerto/budapest/1,10,23,0,200" },
  { jobName: "P_4", url: "https://www.profession.hu/allasok/programozo-fejleszto/budapest/1,10,23,0,75" },
  { jobName: "P_5", url: "https://www.profession.hu/allasok/tesztelo-tesztmernok/budapest/1,10,23,0,80" },
  { jobName: "P_6", url: "https://www.profession.hu/allasok/it-programozas-fejlesztes/budapest/1,10,23,intern" },
  { jobName: "P_7", url: "https://www.profession.hu/allasok/budapest/1,1_2_10_18_25_28,23,0,1_2_6_7_9_11_16_61_69_70_72_73_75_76_77_78_79_80_85_100_144_146_148_197_200_201_202_239_282_283_338_353_361_363_365_375_393_426_427_432_433_448_449_450_453,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1" }
];

export default withTimeout("cron_jobs_P", async () => {
  const siteUrl = process.env.URL;
  const secret = process.env.CRON_SECRET;

  if (!siteUrl || !secret) {
    console.warn("[cron_jobs_P] URL or CRON_SECRET not set, cannot trigger background functions");
    return new Response("Missing env vars", { status: 500 });
  }

  await Promise.all(
    TASKS.map((task) =>
      fetch(`${siteUrl}/.netlify/functions/cron_jobs_P-background`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(task),
      })
        .then(() => console.log(`[cron_jobs_P] triggered ${task.jobName}`))
        .catch((err) => console.error(`[cron_jobs_P] failed to trigger ${task.jobName}: ${err.message}`))
    )
  );

  return new Response(`Triggered ${TASKS.length} background invocations`, { status: 200 });
});
