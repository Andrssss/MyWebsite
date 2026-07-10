// netlify/functions/_active_core.mjs
//
// "Active job" maintenance via in-scrape set difference — write-only-on-change.
//
// Each scraper, at the end of a run, hands us the set of URLs it currently sees
// on its source. We then:
//   • reactivate any job of that source that re-appeared (active=false → true),
//   • deactivate any *aged* job of that source that is no longer in the set
//     (active=true → false), where "aged" means older than ACTIVE_GRACE_DAYS by
//     first_seen.
//
// Key properties:
//   • No `last_seen` column / no per-sighting writes. A job that keeps showing
//     up triggers ZERO writes — only genuine active flips touch the DB.
//   • The first_seen grace window means a freshly-posted job is always shown for
//     ACTIVE_GRACE_DAYS, so a flaky scrape can't immediately hide a new posting.
//   • Deactivation is skipped when the crawl looks incomplete (empty result set,
//     or caller passes complete=false) so a broken scrape can't wipe a source.
//   • Sweep kills are sticky where they must be: for STICKY_SWEEP_DEAD_SOURCES
//     (listing shows closed jobs too) a row the 404-sweep proved dead at its own
//     URL (sweep_dead=true) is never reactivated from mere listing presence.
//
// LinkedIn never calls this (it only sees a recent window); it stays time-based
// on the frontend instead.

import { logRecovery } from "./_error-logger.mjs";

// How long after first_seen a job is unconditionally active before it becomes
// eligible for "is it still on the source?" checking.
export const ACTIVE_GRACE_DAYS = 3;

// Ensure the column/index exist at most once per warm container.
let _schemaReady = false;

export async function ensureActiveSchema(client) {
  if (_schemaReady) return;
  await client.query(
    `ALTER TABLE job_posts ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true`
  );
  // Set by sweepActive404 when a row's OWN detail page proved it dead (404 /
  // closed-banner). For STICKY_SWEEP_DEAD_SOURCES it blocks reactivation from
  // listing presence; cleared only by migrateVolatileUrl (rename = fresh URL).
  await client.query(
    `ALTER TABLE job_posts ADD COLUMN IF NOT EXISTS sweep_dead boolean NOT NULL DEFAULT false`
  );
  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_job_posts_source_active ON job_posts (source, active)`
  );
  _schemaReady = true;
}

/**
 * Reconcile job_posts.active for one source from the URLs seen this run.
 *
 * @param {import("pg").PoolClient} client
 * @param {string} source            DB `source` value being reconciled
 * @param {string[]} foundUrls       URLs currently present on the source (must
 *                                    match the `url` column values exactly)
 * @param {object} [opts]
 * @param {boolean} [opts.complete=true]  false → skip deactivation (partial/failed crawl)
 * @param {number}  [opts.graceDays=ACTIVE_GRACE_DAYS]
 * @returns {Promise<{deactivated:number, reactivated:number, skipped:boolean}>}
 */
export async function reconcileActive(client, source, foundUrls, opts = {}) {
  const complete = opts.complete !== false;
  const graceDays = opts.graceDays ?? ACTIVE_GRACE_DAYS;

  await ensureActiveSchema(client);

  const urls = [...new Set((foundUrls || []).filter(Boolean))];

  // Empty set ⇒ almost certainly a failed/blocked crawl. Never deactivate then.
  if (urls.length === 0) {
    return { deactivated: 0, reactivated: 0, skipped: true };
  }

  // Reactivate rows that re-appeared on the source. Being in foundUrls proves the
  // posting is live, so this is safe even on a partial (complete=false) crawl.
  // Steady state (everything already active) touches zero rows.
  // STICKY_SWEEP_DEAD_SOURCES exception: their listing shows closed jobs too, so
  // presence proves nothing — a sweep-proven death (sweep_dead) stays dead, else
  // the hourly crawl resurrects every kill the morning after (daily flip-flop).
  const noResurrect = STICKY_SWEEP_DEAD_SOURCES.has(source);
  const reactivated = await client.query(
    `UPDATE job_posts
        SET active = true
      WHERE source = $1
        AND active = false
        ${noResurrect ? "AND NOT sweep_dead" : ""}
        AND url = ANY($2::text[])
      RETURNING url`,
    [source, urls]
  );
  if (reactivated.rows.length > 0) {
    logRecovery({
      type: "reactivated",
      source,
      count: reactivated.rows.length,
      urls: reactivated.rows.map((r) => r.url),
    });
  }

  if (!complete) {
    return { deactivated: 0, reactivated: reactivated.rowCount ?? 0, skipped: true };
  }

  // Deactivate aged jobs that vanished from the source.
  const deactivated = await client.query(
    `UPDATE job_posts
        SET active = false
      WHERE source = $1
        AND active = true
        AND first_seen < NOW() - make_interval(days => $3::int)
        AND url <> ALL($2::text[])`,
    [source, urls, graceDays]
  );

  return {
    deactivated: deactivated.rowCount ?? 0,
    reactivated: reactivated.rowCount ?? 0,
    skipped: false,
  };
}

/** Escape a literal string for use inside a POSIX/Postgres regex. */
export function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * URL-churn healer for sources whose job URLs embed a VOLATILE id: the site
 * re-serves the same posting under a new id (`/allas/{slug}-{id}`,
 * `/job/{id}-{slug}`, `…-{counter}`), so url-keyed reconcile would deactivate
 * the old row and insert a duplicate. Call this right BEFORE upserting a job:
 * if `newUrl` is not stored yet but exactly one older row matches
 * `oldUrlPattern` (same stable part, different id) AND that row's url is no
 * longer on the source (not in `currentUrls`), the row is renamed to `newUrl`
 * in place — first_seen (and thus the grace window) is preserved, no duplicate
 * is created, and the fresh url stays navigable.
 *
 * @param {import("pg").PoolClient} client
 * @param {string} source
 * @param {string} newUrl          url built from the current listing
 * @param {string} oldUrlPattern   Postgres regex matching the volatile-id variants
 * @param {string[]} currentUrls   ALL urls seen on the source this run (a row
 *                                  still listed must never be renamed away)
 * @returns {Promise<boolean>}     true if an old row was renamed to newUrl
 */
export async function migrateVolatileUrl(client, source, newUrl, oldUrlPattern, currentUrls) {
  await ensureActiveSchema(client);
  // CTE keeps hold of the pre-rename url so the recovery log can show from→to.
  const res = await client.query(
    `WITH victim AS (
        SELECT id, url FROM job_posts
         WHERE source = $1
           AND url ~ $3
           AND url <> $2
           AND url <> ALL($4::text[])
           AND NOT EXISTS (SELECT 1 FROM job_posts WHERE source = $1 AND url = $2)
         ORDER BY active DESC, first_seen DESC
         LIMIT 1)
     UPDATE job_posts
        SET url = $2, active = true, sweep_dead = false
       FROM victim
      WHERE job_posts.id = victim.id
      RETURNING victim.url AS old_url`,
    [source, newUrl, oldUrlPattern, (currentUrls || []).filter(Boolean)]
  );
  const migrated = (res.rowCount ?? 0) > 0;
  if (migrated) {
    logRecovery({
      type: "url-migrated",
      source,
      from: res.rows[0].old_url,
      to: newUrl,
    });
  }
  return migrated;
}

// Sources whose sites answer a DEAD job url with a 200 redirect to a generic
// listing page instead of a 404 (ydiak → /aktualis-diakmunkaink, eudiakok →
// /404), so the plain 404 rule never fires. For these, "redirected to a
// DIFFERENT path" counts as dead. Kept per-source: many healthy sites redirect
// http→https or add a trailing slash, which keeps the path and stays alive
// under this rule.
//
// ⚠️ alllocaljobs must NEVER be added here (nor to BANNER_DEAD_SOURCES): its
// detail urls are session-gated, so a cookieless fetch of a LIVE job also
// 200-redirects to a different path (/állások?requested_vacancy_not_found=1)
// — the redirect rule would kill live rows. Its deactivation is owned entirely
// by its own scraper's reconcileActive (full slice walk).
export const REDIRECT_DEAD_SOURCES = new Set(["ydiak", "eudiakok"]);

// Sources whose LISTING keeps showing already-closed jobs, so being in
// foundUrls does not prove a posting is live. For these, reconcileActive's
// reactivation skips rows the 404-sweep proved dead at their own detail page
// (sweep_dead=true) — without this the hourly crawl would resurrect every
// sweep kill and the pair would flip-flop daily. One-way by design: a
// sweep_dead row only returns via migrateVolatileUrl (new URL), which is fine —
// talent ids are single-use (reposts get a fresh id) and purged ids stay 404.
//
// talent (2026-07-10): its search results are ALSO a rotating nondeterministic
// subset of the source (live jobs drop in/out run-to-run), so its scraper
// reconciles reactivate-only (complete:false) — absence proves nothing either.
// The daily sweep (404 / id-anchored system_status=2) is its sole deactivator.
export const STICKY_SWEEP_DEAD_SOURCES = new Set(["talent"]);

// Sources whose sites answer a DEAD job url with a plain 200 page — no 404,
// no redirect — so neither sweep rule above can see it. For these the sweep
// also fetches the BODY; the rule is either
//   • a string: case-insensitive banner match counts as dead (bluebird:
//     "Az álláshirdetés lejárt"), or
//   • a predicate (row, body) => boolean for sources where a plain substring
//     can't discriminate.
// Only add a string marker after verifying on a LIVE listed job that its page
// does NOT contain it — SPA bundles ship such texts as i18n templates on EVERY
// page (talent/trenkwalder/qdiak/nofluffjobs all do).
//
// talent: the visible "Már nem fogadnak jelentkezéseket" banner is rendered
// from the job object's `system_status` (2 = expired, 1 = live) in the
// Next.js flight payload. The page embeds SEVERAL job objects (related jobs
// too!), so the status MUST be read from the object anchored at the url's own
// id — a global regex grabs some other job's status. Validated 2026-07-06 on
// 14/14 browser-rendered truth pages; purged jobs turn HTTP 404 (plain rule
// catches those). Missing anchor/field → fail-safe alive. Secondary signal:
// when talent SSR-renders the banner (2026-07-01 behaviour), it appears as
// element text `>Már nem fogadnak…<` — the i18n dict form is always
// `:"Már nem fogadnak…"`, so the tag boundary keeps it false-positive-free.
export const BANNER_DEAD_SOURCES = {
  bluebird: "az álláshirdetés lejárt",
  talent: (row, body) => {
    if (/>\s*Már nem fogadnak jelentkezéseket\s*</i.test(body)) return true;
    const id = (row.url.match(/[?&]id=(\d+)/) || [])[1];
    if (!id) return false;
    let i = body.indexOf(`\\"id\\":\\"${id}\\"`); // flight-payload (escaped) form
    if (i < 0) i = body.indexOf(`"id":"${id}"`); // plain-JSON fallback
    if (i < 0) return false;
    const m = body.slice(i, i + 3000).match(/system_status\\?"\s*:\s*(\d+)/);
    return !!m && m[1] === "2";
  },
  // nofluffjobs: dead postings stay HTTP 200 forever (SEO), so only the body
  // can tell. Two independent signals, either proves death (validated
  // 2026-07-07 on 3 live PUBLISHED + 1 expired DISABLED page; extended
  // 2026-07-08 after a job whose SSR fell back to a search-results page
  // instead of the expired-posting template surfaced "EXPIRED" instead of
  // "DISABLED" — re-verified 0 hits for either value on a fresh live page):
  //   • Angular SSR renders <nfj-posting-expired-breadcrumbs> ONLY on dead
  //     postings — live pages carry the expiry texts solely as i18n dict
  //     entries ("EXPIRED_OFFER":{…}), never as an element, so the tag
  //     boundary keeps it false-positive-free (talent's >…< trick);
  //   • the transfer-state JSON keys the posting by its OWN slug
  //     ("/posting/{slug}?…":{"status":"DISABLED"} or "EXPIRED"}). On live
  //     pages the same key opens the full job object whose own status sits
  //     hundreds of KB in, so DISABLED/EXPIRED right after the slug key can
  //     only be this posting's verdict — never a related job's (those aren't
  //     keyed).
  nofluffjobs: (row, body) => {
    if (/<nfj-posting-expired/i.test(body)) return true;
    const slug = (row.url.match(/\/hu\/job\/([^/?#]+)/) || [])[1];
    if (!slug) return false;
    const i = body.indexOf(`"/posting/${slug}?`);
    if (i < 0) return false;
    const m = body.slice(i, i + 400).match(/"status"\s*:\s*"([A-Z_]+)"/);
    return !!m && (m[1] === "DISABLED" || m[1] === "EXPIRED");
  },
};

function _pathOf(u) {
  try {
    const p = new URL(u).pathname.replace(/\/+$/, "");
    return p || "/";
  } catch {
    return null;
  }
}

function _isDeadResult(row, res) {
  if (!res) return false;
  if (res.status === 404) return true;
  if (
    REDIRECT_DEAD_SOURCES.has(row.source) &&
    res.status >= 200 && res.status < 400 &&
    res.finalUrl
  ) {
    const a = _pathOf(row.url);
    const b = _pathOf(res.finalUrl);
    return a !== null && b !== null && a !== b;
  }
  const rule = BANNER_DEAD_SOURCES[row.source];
  if (rule && res.status === 200 && typeof res.body === "string") {
    if (typeof rule === "function") {
      if (rule(row, res.body)) return true;
    } else if (res.body.toLowerCase().includes(rule)) {
      return true;
    }
  }
  return false;
}

/**
 * 404 sweep — the cross-source safety net for reconcileActive.
 *
 * reconcileActive only works when a scraper can enumerate its source's FULL
 * current listing. Windowed / synthetic-URL sources (RSS "latest N", hash URLs)
 * can't, so their dead jobs never fall out of the set. This sweep instead asks
 * each active job's OWN URL whether it still exists, and deactivates the ones
 * that are provably gone: final HTTP 404, for REDIRECT_DEAD_SOURCES a 200 that
 * landed on a different path (listing-page redirect), or for
 * BANNER_DEAD_SOURCES a 200 whose body carries the source's closed-banner.
 *
 * Network-agnostic: the caller injects
 * `checkFinal(url, {wantBody}) => Promise<{status:number, finalUrl:string|null, body?:string}>`
 * returning the final status and final URL after redirects — plus the response
 * body when `wantBody` is set (only requested for BANNER_DEAD_SOURCES rows).
 * Negative statuses (local failure) and 403/429/5xx are treated as "still
 * alive". Each dead verdict is re-checked once to drop transients before it
 * deactivates.
 *
 * LinkedIn is excluded: bot-blocked (no clean 404s) and shown time-based on the
 * frontend, so its `active` flag is irrelevant.
 *
 * @param {import("pg").PoolClient} client
 * @param {(url: string, opts?: {wantBody?: boolean}) => Promise<{status:number, finalUrl:string|null, body?:string}>} checkFinal
 * @param {object} [opts]
 * @param {number} [opts.concurrency=12]
 * @returns {Promise<{checked:number, suspects:number, deactivated:number}>}
 */
export async function sweepActive404(client, checkFinal, opts = {}) {
  const concurrency = Math.max(1, opts.concurrency ?? 12);

  await ensureActiveSchema(client);

  const { rows } = await client.query(
    `SELECT url, source FROM job_posts WHERE active = true AND source <> 'LinkedIn'`
  );
  if (rows.length === 0) return { checked: 0, suspects: 0, deactivated: 0 };

  // Round-robin the URLs across `concurrency` workers. Body is only fetched
  // where a banner rule needs it.
  const wantBody = (row) => ({ wantBody: BANNER_DEAD_SOURCES[row.source] !== undefined });
  const results = new Map();
  const lanes = Array.from({ length: concurrency }, (_, i) =>
    rows.filter((_, idx) => idx % concurrency === i)
  );
  await Promise.all(
    lanes.map(async (list) => {
      for (const row of list) results.set(row.url, await checkFinal(row.url, wantBody(row)));
    })
  );

  // Re-check first-pass dead verdicts once; only a still-dead row deactivates.
  const suspects = rows.filter((r) => _isDeadResult(r, results.get(r.url)));
  const confirmed = [];
  for (const row of suspects) {
    if (_isDeadResult(row, await checkFinal(row.url, wantBody(row)))) confirmed.push(row.url);
  }

  let deactivated = 0;
  if (confirmed.length) {
    // sweep_dead records that the row died at its OWN URL (double-checked) —
    // for STICKY_SWEEP_DEAD_SOURCES this keeps reconcileActive from
    // resurrecting it off a listing that still shows closed jobs.
    const res = await client.query(
      `UPDATE job_posts
          SET active = false, sweep_dead = true
        WHERE active = true
          AND source <> 'LinkedIn'
          AND url = ANY($1::text[])`,
      [confirmed]
    );
    deactivated = res.rowCount ?? 0;
  }

  return { checked: rows.length, suspects: suspects.length, deactivated };
}

/**
 * Time-based expiry for push-only sources (no scraper → reconcileActive never
 * runs, so their rows would stay active forever). Deactivates rows older than
 * `days` by first_seen. Used for `random_email` (10 days, per user decision
 * 2026-07-04). One-way: a re-pushed job arrives as a fresh insert.
 *
 * @returns {Promise<number>} rows deactivated
 */
export async function expireAgedPushSource(client, source, days) {
  await ensureActiveSchema(client);
  const res = await client.query(
    `UPDATE job_posts
        SET active = false
      WHERE source = $1
        AND active = true
        AND first_seen < NOW() - make_interval(days => $2::int)`,
    [source, days]
  );
  return res.rowCount ?? 0;
}
