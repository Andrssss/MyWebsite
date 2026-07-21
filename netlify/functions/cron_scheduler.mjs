export const config = {
  // Fires ONLY at the minutes present in GRID below (hours 4–22 UTC).
  // Keep this minute list exactly in sync with the GRID keys — a minute that
  // isn't in GRID does nothing, a GRID key that isn't listed here never fires.
  schedule: "3,8,11,12,13,14,22,27,33,38,43,45,52 4-22 * * *",
};

import { withTimeout } from "./_error-logger.mjs";

/**
 * Staggered cron scheduler.
 *
 * Replaces the old parallel-blast dispatchers (cron_dispatcher.mjs +
 * cron_dispatcher_test.mjs, both deleted). Instead of POSTing every hourly
 * worker at once (the old :55 blast), this fires once per scheduled minute and
 * triggers only the worker(s) mapped to that minute, spreading load across the
 * whole hour. See CRON_SCHEDULE.md for the full minute-by-minute timeline.
 *
 * Why a scheduler and not per-file `config.schedule` on each worker: the
 * cron_jobs_*-background workers hard-require the CRON_SECRET bearer (401
 * otherwise), and Netlify's own scheduled invocation does NOT send that header
 * — so a worker cannot schedule itself. This scheduler holds the secret and
 * POSTs it, exactly like the old dispatcher did. The LinkedIn shards
 * (L_1..L_11) DON'T check the secret, so they stay self-scheduled in their own
 * files (re-spaced ~5 min apart) rather than being routed through here.
 *
 * Spacing rules baked into the grid:
 *   - Heavy sources get a clear ≥5 min gap before the next job starts:
 *     profession (:15, via self-scheduled cron_jobs_P) and alllocaljobs (:45).
 *   - <10-active sources are packed 1 min apart (:11–:14) — each finishes in
 *     well under a minute, so the next one can start immediately.
 */
const GRID = {
  3:  [{ name: "cron_jobs_T-background" }],            // talent (~165)
  8:  [{ name: "cron_jobs_NOFLUFFJOBS-background" }],  // nofluffjobs (~44)
  // <10-active sources, 1 min apart (finish in seconds):
  11: [{ name: "cron_jobs_RAIFFEISEN-background" }],   // raiffeisen (~10)
  12: [{ name: "cron_jobs_KH-background" }],           // kh (~9)
  13: [{ name: "cron_jobs_ERSTE-background" }],        // erste (~7)
  14: [{ name: "cron_jobs_VALOREBASIS-background" }],  // valorebasis (~2)
  22: [{ name: "cron_jobs_DIAK_3-background" }],       // otp + wherewework (~32)
  27: [{ name: "cron_jobs_MIX-background" }],          // kuka/zyntern/dreamjobs (~35)
  33: [{ name: "cron_jobs_MBH-background" }],          // mbh (~29)
  38: [{ name: "cron_jobs_BLUE-background" }],         // bluebird (~19)
  43: [{ name: "cron_jobs_DIAK_1-background" }],       // schonherz/minddiak/muisz (~20)
  45: [{ name: "cron_jobs_ALLLOCALJOBS-background" }], // alllocaljobs (~221) — 5 min clear after
  52: [{ name: "cron_jobs_F_3-background", body: { startPage: 1 } }], // workly (~17)
};

export default withTimeout("cron_scheduler", async () => {
  const siteUrl = process.env.URL;
  const secret = process.env.CRON_SECRET;

  if (!siteUrl || !secret) {
    console.warn("[cron_scheduler] URL or CRON_SECRET not set, cannot trigger background functions");
    return new Response("Missing env vars", { status: 500 });
  }

  const minute = new Date().getUTCMinutes();
  const tasks = GRID[minute] || [];

  if (tasks.length === 0) {
    console.log(`[cron_scheduler] minute ${minute}: nothing scheduled`);
    return new Response(`Nothing scheduled for minute ${minute}`, { status: 200 });
  }

  await Promise.all(
    tasks.map((task) =>
      fetch(`${siteUrl}/.netlify/functions/${task.name}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(task.body ?? {}),
      })
        .then(() => console.log(`[cron_scheduler] minute ${minute}: triggered ${task.name}`))
        .catch((err) => console.error(`[cron_scheduler] failed to trigger ${task.name}: ${err.message}`))
    )
  );

  return new Response(`Minute ${minute}: triggered ${tasks.length} background invocation(s)`, { status: 200 });
});
