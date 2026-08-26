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
  // api.startup.jobs official REST API, role=engineering&country=HU. Tiny
  // volume (well under 10) and the API itself only surfaces the last 14 days
  // of postings, so hourly polling would buy nothing — daily is plenty.
  // Reconciles reactivate-only (see cron_jobs_STARTUPJOBS-background.mjs
  // header); the 404 sweep below is its sole deactivator. Added 2026-07-28.
  { name: "cron_jobs_STARTUPJOBS-background" },
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
  // ATS-crawl (WEB_CRAWLER_PLAN.md F1, added 2026-08-26): publikus ATS-board
  // API-k aratása az ats_tenants tábla alapján, futásonként ATS_CRAWL_BATCH (20)
  // tenant. Napi tier, mert a seed 19 tenantja egy futásban elfér, és ezek a
  // boardok napokban mérve mozognak, nem órákban. Ha a tenant-lista száz fölé nő
  // (F2, kereső-alapú slug-felderítés), ez átkerül az órás dispatcherre, hogy a
  // rotáció körbeérjen — a worker eleve last_checked szerint lapoz.
  { name: "cron_jobs_ATSCRAWL-background" },
  // ATS slug-felderítés (WEB_CRAWLER_PLAN.md F2, added 2026-08-26): a
  // job_posts.company cégnevekből slug-jelölteket képez és leprobálja őket a
  // három tiszta-404-es provideren; a találatok az ats_tenants-be kerülnek, és
  // a KÖVETKEZŐ napi körben aratja le őket az ATSCRAWL worker. (A dispatcher
  // Promise.all-lal indít, tehát a sorrend nem garantált — nem is kell: az
  // egynapos csúszás ára nulla.) Futásonként ~45 jelölt × max 3 kérés.
  { name: "cron_ats_discover-background" },
  // Cross-source safety net: deactivates any active non-LinkedIn job whose URL
  // now returns HTTP 404 (see _active_core.mjs sweepActive404). Once/day is
  // plenty — the per-source reconcile handles the common case hourly.
  { name: "cron_404sweep-background" },
  // Full session-aware dead-check across EVERY active alllocaljobs row, once a
  // day (see that file's header: the hourly scraper's own confirmDead gate
  // can't reach rows the site's listing keeps showing even after they've
  // individually closed — this is the guaranteed-coverage complement to it).
  { name: "cron_alllocaljobs_deepsweep-background" },
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
