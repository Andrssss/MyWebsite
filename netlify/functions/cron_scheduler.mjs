export const config = {
  // Fires ONLY at the minutes present in GRID below (hours 4–19 UTC).
  // Keep this minute list exactly in sync with the GRID keys — a minute that
  // isn't in GRID does nothing, a GRID key that isn't listed here never fires.
  schedule: "2,5,6,7,9,10,11,13,15,17,18,19,21,22 4-19 * * *",
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
 * (L_1..L_9) DON'T check the secret, so they stay self-scheduled in their own
 * files (re-spaced ~5 min apart) rather than being routed through here.
 *
 * Spacing rules baked into the grid:
 *   - LinkedIn shards are 4 min apart (L_1..L_9, :00-:32 — was L_1..L_11
 *     :00-:40 until a 2026-08-18 dedup+merge dropped 2 shards), with the
 *     experience backfill at :36 (4 min after the last shard, moved back
 *     from :44 the same day to keep the original gap).
 *   - The profession dispatcher stays at :15 and alllocaljobs is at :19, so
 *     the two have the required 4 min buffer.
 *   - Other non-LinkedIn jobs also follow 4 min gaps by design.
 */
const GRID = {
  2:  [{ name: "cron_jobs_T-background" }],            // talent (~165)
  5:  [{ name: "cron_jobs_NOFLUFFJOBS-background" }],  // nofluffjobs (~44)
  6: [{ name: "cron_jobs_RAIFFEISEN-background" }],   // raiffeisen (~10)
  7: [{ name: "cron_jobs_KH-background" }],           // kh (~9)
  9: [{ name: "cron_jobs_ALLLOCALJOBS-background" }], // alllocaljobs (~221) — 4 min after profession
  10: [{ name: "cron_jobs_ERSTE-background" }],        // erste (~7)
  11: [{ name: "cron_jobs_VALOREBASIS-background" }],  // valorebasis (~2)
  13: [{ name: "cron_jobs_DIAK_3-background" }],       // otp + wherewework (~32)
  15: [{ name: "cron_jobs_MIX-background" }],          // kuka/zyntern/dreamjobs (~35)
  17: [{ name: "cron_jobs_MBH-background" }],          // mbh (~29)
  18: [{ name: "cron_jobs_PRODIAK-background" }],      // prodiak (~13, IT+Budapest)
  19: [{ name: "cron_jobs_BLUE-background" }],         // bluebird (~19)
  21: [{ name: "cron_jobs_DIAK_1-background" }],       // schonherz/minddiak/muisz (~20)
  22: [{ name: "cron_jobs_F_3-background", body: { startPage: 1 } }], // workly (~17)
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
