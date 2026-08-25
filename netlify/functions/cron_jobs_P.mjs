export const config = {
  // Moved off :15 2026-08-18 — it collided with the scheduler GRID's MIX
  // slot (both firing at :15, 0 min apart). Sits in the otherwise-empty
  // LinkedIn-only corridor after L_8 (:28) and before CRON_EX (:32); passed
  // through :34 and :30 the same day before settling on :29.
  schedule: "29 4-19 * * *",
};

import { withTimeout } from "./_error-logger.mjs";

/**
 * Unified Profession dispatcher.
 *
 * Each task scrapes one Profession.hu listing URL via a single background
 * invocation. Background functions have a 15 min limit, which is enough for
 * full pagination of any single listing.
 */
// 2026-08-25 (user-döntés: "profession-nél minden szintet akarok"): a P_2-ről
// lekerült a `,gyakornok`, a P_6-ról a `,intern` szint-slug. A P_6 ezzel
// karakterre azonos lett a P_1-gyel, ezért törölve — a P_2 viszont mostantól a
// TELJES IT-üzemeltetés kategória (eddig CSAK a gyakornoki szeletét láttuk).
// A senior találatokat nem dobjuk el: a seniorAwareExperience() experience=
// "senior"-ra írja őket, a frontend alapból rejti.
//
// FIGYELEM: mind a task ugyanazt a source kulcsot használja ("profession-intern",
// ld. cron_jobs_P-background.mjs) — a név mostantól félrevezető, DE nem nevezhető
// át: a `source` a sor identitásának része (ON CONFLICT (source, url)), átnevezés
// esetén minden meglévő sor árván maradna.
const TASKS = [
  { jobName: "P_1", url: "https://www.profession.hu/allasok/it-programozas-fejlesztes/budapest/1,10,23" },
  { jobName: "P_2", url: "https://www.profession.hu/allasok/it-uzemeltetes-telekommunikacio/budapest/1,25,23" },
  { jobName: "P_3", url: "https://www.profession.hu/allasok/adatbazisszakerto/budapest/1,10,23,0,200" },
  { jobName: "P_4", url: "https://www.profession.hu/allasok/programozo-fejleszto/budapest/1,10,23,0,75" },
  { jobName: "P_5", url: "https://www.profession.hu/allasok/tesztelo-tesztmernok/budapest/1,10,23,0,80" },
];

export default withTimeout("cron_jobs_P", async () => {
  const siteUrl = process.env.URL;
  const secret = process.env.CRON_SECRET;

  if (!siteUrl || !secret) {
    console.warn("[cron_jobs_P] URL or CRON_SECRET not set, cannot trigger background functions");
    return new Response("Missing env vars", { status: 500 });
  }

  // All tasks in a single background call so foundUrls accumulates across all profession
  // search URLs before reconcileActive runs — prevents each URL from overwriting the previous.
  await fetch(`${siteUrl}/.netlify/functions/cron_jobs_P-background`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ tasks: TASKS }),
  })
    .then(() => console.log(`[cron_jobs_P] triggered all ${TASKS.length} tasks in one background call`))
    .catch((err) => console.error(`[cron_jobs_P] failed to trigger background: ${err.message}`));

  return new Response(`Triggered ${TASKS.length} tasks in one background call`, { status: 200 });
});
