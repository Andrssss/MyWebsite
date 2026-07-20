export const config = {
  schedule: "0 14 * * *",
};

import { withTimeout } from "./_error-logger.mjs";

/**
 * Daily cron dispatcher — low-volume sources (each < 10 active postings).
 *
 * These scrapers each feed a single source (or only sub-sources) that stays
 * under ~10 open jobs, so hourly crawling is wasteful. They run once per day at
 * 14:00 UTC instead. Every listed function scrapes ONLY sources that are all
 * under 10 — mixed scrapers that ALSO feed a source ≥10 (DIAK_1, DIAK_3, MIX, …)
 * stay on the hourly dispatcher.
 *
 * Sources (approx. counts at time of split, 2026-07-01):
 *   A_K=karrierhungaria(3), CG=cg-jobstream(7), ATS=wise(7)+roland(1),
 *   MFB(5), UNICREDIT(1), EUDIAKOK(3), MELODIAK(2), ATLASZ(1),
 *   PANNONDIAK(1), TRENKWALDER(5), WORKCENTER(9)
 * Added 2026-07-20: DIAK_2=ydiak(0)+qdiak(7) — a mixed scraper, but BOTH its
 *   sources are under 10 now (unlike DIAK_1/DIAK_3), so it fits the <10 rule.
 */
const TARGETS = [
  { name: "cron_jobs_A_K-background" },
  { name: "cron_jobs_CG-background" },
  { name: "cron_jobs_ATS-background" },
  { name: "cron_jobs_MFB-background" },
  { name: "cron_jobs_UNICREDIT-background" },
  { name: "cron_jobs_EUDIAKOK-background" },
  { name: "cron_jobs_MELODIAK-background" },
  { name: "cron_jobs_ATLASZ-background" },
  { name: "cron_jobs_PANNONDIAK-background" },
  { name: "cron_jobs_TRENKWALDER-background" },
  // Moved from the hourly dispatcher 2026-07-20 (user decision): ydiak finds
  // nothing (IT/Budapest listing empty) and qdiak sits at 7 rows, none new in
  // a week. Scrapes sources "ydiak" + "qdiak"; both reconcile daily now.
  { name: "cron_jobs_DIAK_2-background" },
  // Single-company WordPress source (nixstech.com REST API). ~16 total openings,
  // Budapest, most junior/medior after the senior-skip — well under the <10-per-
  // source daily-tier rule. Added 2026-07-20.
  { name: "cron_jobs_NIX-background" },
  // AI-scraped worker (cron_jobs_AI-background) is intentionally NOT triggered
  // yet — Phase 1 is in-session/manual extraction via ai-ingest.mjs (no
  // Anthropic API). When we automate it (intended cadence: every 5 hours), add
  // it to a 5-hourly trigger, not this daily one. See AI_SCRAPER_PLAN.md.
  // cron_jobs_WORKCENTER-background DROPPED 2026-07-08 (user decision): WAF has
  // 403-blocked the Netlify IP since 05-07 (HTML and REST alike), so neither
  // ingest nor reconcile could run and the sweep's 403s read as "alive" — the
  // source was frozen at 9 forever-active rows. Rows deactivated manually the
  // same day. Re-add here (and reactivate what's still live) if a proxy ever
  // makes the source reachable again.
  // Cross-source safety net: deactivates any active non-LinkedIn job whose URL
  // now returns HTTP 404 (see _active_core.mjs sweepActive404). Once/day is
  // plenty — the per-source reconcile handles the common case hourly.
  { name: "cron_404sweep-background" },
];

export default withTimeout("cron_dispatcher_daily", async () => {
  const siteUrl = process.env.URL;
  const secret = process.env.CRON_SECRET;

  if (!siteUrl || !secret) {
    console.warn("[cron_dispatcher_daily] URL or CRON_SECRET not set, cannot trigger background functions");
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
        .then(() => console.log(`[cron_dispatcher_daily] triggered ${task.name}`))
        .catch((err) => console.error(`[cron_dispatcher_daily] failed to trigger ${task.name}: ${err.message}`))
    )
  );

  return new Response(`Triggered ${TARGETS.length} background invocations`, { status: 200 });
});
