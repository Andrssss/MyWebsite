// Daily FULL dead-check for alllocaljobs — every currently active row, once
// a day, checked at its own detail url via a real session.
//
// Why this exists (2026-07-30, user-jelzés + élő 294-soros ellenőrzés): the
// hourly cron_jobs_ALLLOCALJOBS-background.mjs already has a confirmDead gate
// in its reconcileActive call, but that gate only ever runs on rows ABSENT
// from that run's listing scrape. alllocaljobs' own search/listing index lags
// behind individual postings closing — a dead job (its own detail page
// session-redirects to /állások?requested_vacancy_not_found=1) can keep
// showing as a card in search results indefinitely, so it never becomes
// "absent" and the hourly gate never reaches it. Live measurement: 69 of 294
// currently-active rows were already dead this way. A first attempt bolted a
// randomized partial sample onto the hourly gate (reconcileActive's
// confirmDeadExtraLimit) — rejected (user: partial/probabilistic coverage
// isn't good enough) in favor of this: a dedicated job that checks EVERY
// active row, once a day, full stop.
//
// Session-fetch machinery (makeJar/fetchWithSession/fixLocationEncoding) is
// shared with the hourly scraper via _alllocaljobs_core.mjs — a fix to either
// (the latin1/utf8 Location bug, cookie handling) can't drift between two
// copies. Triggered by cron_dispatcher_daily (14:00 UTC), same slot as the
// other once-a-day sources / cron_404sweep-background.

import { Pool } from "pg";
import { withTimeout, logRecovery } from "./_error-logger.mjs";
import { ACTIVE_GRACE_DAYS } from "./_active_core.mjs";
import { BASE, makeJar, fetchWithSession } from "./_alllocaljobs_core.mjs";

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Fail-safe time budget: the background function gets 14 min total. At ~294
// active rows and ~700ms/row (350ms sleep + request), a full pass takes
// ~3-4 min today, but the active count will grow — if it ever gets close to
// the limit, stop checking (unconfirmed rows stay active, tomorrow's run
// picks up where this one left off) rather than risk a timeout mid-UPDATE.
const CHECK_DEADLINE_MS = 12 * 60 * 1000;

const _runJob = withTimeout("cron_alllocaljobs_deepsweep-background", async () => {
  const runStart = Date.now();
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT url FROM job_posts
        WHERE source = 'alllocaljobs'
          AND active = true
          AND first_seen < NOW() - make_interval(days => $1::int)`,
      [ACTIVE_GRACE_DAYS]
    );
    console.log(`[alllocaljobs-deepsweep] ${rows.length} active row(s) to check`);

    const jar = makeJar();
    await fetchWithSession(`${BASE}/%C3%A1ll%C3%A1sok/budapest`, jar);

    const dead = [];
    let checked = 0;
    let stoppedEarly = false;
    for (const { url } of rows) {
      if (Date.now() - runStart >= CHECK_DEADLINE_MS) {
        stoppedEarly = true;
        break;
      }
      await sleep(350);
      try {
        const { finalUrl } = await fetchWithSession(url, jar);
        if (finalUrl.includes("requested_vacancy_not_found")) dead.push(url);
      } catch (err) {
        // network hiccup / timeout — fail-safe: unconfirmed stays active,
        // tomorrow's run tries again.
      }
      checked++;
    }

    let deactivated = 0;
    if (dead.length) {
      const res = await client.query(
        `UPDATE job_posts SET active = false
          WHERE source = 'alllocaljobs' AND active = true AND url = ANY($1::text[])`,
        [dead]
      );
      deactivated = res.rowCount ?? 0;
      if (deactivated > 0) {
        logRecovery({ type: "deepsweep-deactivated", source: "alllocaljobs", count: deactivated, urls: dead });
      }
    }

    console.log(
      `[alllocaljobs-deepsweep] checked=${checked}/${rows.length}, deactivated=${deactivated}` +
      (stoppedEarly ? " (stopped early — time budget; remainder deferred to next run)" : "")
    );
  } finally {
    client.release();
  }
  return new Response("OK");
});

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  const expected = process.env.CRON_SECRET;
  if (!expected || token !== expected) {
    return new Response("Unauthorized", { status: 401 });
  }
  return _runJob(request);
};
