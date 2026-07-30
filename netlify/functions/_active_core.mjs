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
 * @param {boolean} [opts.emptyIsValid=false]  true → an EMPTY foundUrls set is a
 *   legitimate "this source has no open jobs right now" answer, not a failed crawl,
 *   so deactivation still runs. Only pass this when the caller has PROVEN the fetch
 *   succeeded (i.e. it also passes complete:true on the same run) — otherwise a
 *   blocked crawl would wipe the whole source.
 * @param {number}  [opts.graceDays=ACTIVE_GRACE_DAYS]
 * @param {(url: string) => Promise<boolean>} [opts.confirmDead]  optional per-row
 *   death gate. When given, a row that is aged AND absent from foundUrls is NOT
 *   deactivated on absence alone — it is only switched off if confirmDead(url)
 *   resolves true (the caller proved it dead at the row's OWN url). Anything
 *   unconfirmed — still live, a network error, a thrown fetch, or the caller
 *   running out of time and returning false — stays active. Fail-safe by design:
 *   for sources whose listing can transiently drop a LIVE posting (alllocaljobs:
 *   a job slips out of the paginated slice/browse union), absence is not proof of
 *   death, so we make the site say so before hiding the row. Errors thrown by
 *   confirmDead are swallowed as "not dead" (keep active).
 * @returns {Promise<{deactivated:number, reactivated:number, skipped:boolean, confirmChecked?:number}>}
 */
export async function reconcileActive(client, source, foundUrls, opts = {}) {
  const complete = opts.complete !== false;
  const emptyIsValid = opts.emptyIsValid === true;
  const graceDays = opts.graceDays ?? ACTIVE_GRACE_DAYS;

  await ensureActiveSchema(client);

  const urls = [...new Set((foundUrls || []).filter(Boolean))];

  // Empty set ⇒ almost certainly a failed/blocked crawl. Never deactivate then.
  //
  // EXCEPTION (emptyIsValid): for a source that legitimately empties out, this
  // guard makes its rows IMMORTAL — reconcile can never deactivate them, and if
  // the sweep's rules don't fire either they stay active forever (observed on
  // eudiakok 2026-07-14: listing = 0 jobs, 2 rows stuck active). A caller that
  // has proven the fetch succeeded may opt in, and only the deactivation half
  // runs (there is nothing to reactivate against an empty set).
  if (urls.length === 0) {
    if (!(emptyIsValid && complete)) {
      return { deactivated: 0, reactivated: 0, skipped: true };
    }
    const gone = await client.query(
      `UPDATE job_posts
          SET active = false
        WHERE source = $1
          AND active = true
          AND first_seen < NOW() - make_interval(days => $2::int)`,
      [source, graceDays]
    );
    return { deactivated: gone.rowCount ?? 0, reactivated: 0, skipped: false };
  }

  // Reactivate rows that re-appeared on the source. Being in foundUrls proves the
  // posting is live, so this is safe even on a partial (complete=false) crawl.
  // Steady state (everything already active) touches zero rows.
  // STICKY_SWEEP_DEAD_SOURCES exception: their listing shows closed jobs too, so
  // presence proves nothing — a sweep-proven death (sweep_dead) stays dead, else
  // the hourly crawl resurrects every kill the morning after (daily flip-flop).
  // sweep_dead is cleared on the way back in: the flag means "the sweep proved this
  // row dead at its own url", and listing presence has just disproved it. Keeping the
  // invariant (sweep_dead ⇒ active = false) is what lets reviveSweepDead below scan
  // `sweep_dead AND NOT active` without picking up stale flags on live rows.
  // No-op for STICKY_SWEEP_DEAD_SOURCES — there the guard below never lets a
  // sweep_dead row reach this UPDATE in the first place.
  const noResurrect = STICKY_SWEEP_DEAD_SOURCES.has(source);
  const reactivated = await client.query(
    `UPDATE job_posts
        SET active = true, sweep_dead = false
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

  // Aged jobs that vanished from the source are the deactivation candidates.
  // With a confirmDead gate we prove each dead at its OWN url before hiding it
  // (listing-absence alone is unreliable for the source); without it, absence is
  // the verdict as before.
  if (typeof opts.confirmDead === "function") {
    const { rows: candidates } = await client.query(
      `SELECT url FROM job_posts
        WHERE source = $1
          AND active = true
          AND first_seen < NOW() - make_interval(days => $3::int)
          AND url <> ALL($2::text[])`,
      [source, urls, graceDays]
    );
    const dead = [];
    for (const { url } of candidates) {
      let isDead = false;
      try {
        isDead = (await opts.confirmDead(url)) === true;
      } catch {
        isDead = false; // fail-safe: unconfirmed stays active
      }
      if (isDead) dead.push(url);
    }
    let confirmedOff = 0;
    if (dead.length) {
      const res = await client.query(
        `UPDATE job_posts
            SET active = false
          WHERE source = $1
            AND active = true
            AND url = ANY($2::text[])`,
        [source, dead]
      );
      confirmedOff = res.rowCount ?? 0;
    }
    return {
      deactivated: confirmedOff,
      reactivated: reactivated.rowCount ?? 0,
      skipped: false,
      confirmChecked: candidates.length,
    };
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
// by its own scraper's reconcileActive (full slice walk), which now passes a
// confirmDead gate: an aged, listing-absent row is only switched off once a
// SESSION-cookie'd fetch of its own url redirects to requested_vacancy_not_found
// (the only trustworthy death signal here — with a valid session a live job
// loads 200, so this can't false-kill the ~10% that slip out of the paginated
// union).
//
// profession-intern (2026-07-12): a posting drops off ALL 6 scraped category
// listings well before it actually closes — profession.hu's search demotes
// aged ads out of the paginated results while the ad itself stays fully live
// and reachable (validated: NIX Tech "Angular Developer" -2943319, "KI-Engineer"
// -2938506, Cushman & Wakefield "BI Analyst" -2935497 — all plain 200, no
// closed banner, exhaustively absent from every category/page we crawl). A
// job that's ACTUALLY closed 301-redirects to an unrelated /allasok/ category
// listing (different path) — confirmed on 8/8 aged-out rows. So listing
// absence proves nothing for this source; only the redirect does.
// wherewework (2026-07-22): a dead job 302-redirects to the generic /en/jobs
// board root (a different path) instead of banner-ing or 404-ing; a live job
// stays a plain 200 at its own path. Confirmed 6/6 dead + 3/3 live samples.
export const REDIRECT_DEAD_SOURCES = new Set(["ydiak", "eudiakok", "profession-intern", "wherewework"]);

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
//
// allasportal (2026-07-11): aggregator — its "redirect" rows' URLs
// (/munka/redirect/<id>) 302 to the real posting (cvonline). A dead id turns
// plain HTTP 404, so the sweep catches deaths the moment cvonline pulls the
// posting; the allasportal LISTING lags behind and would resurrect the row
// next hour (sweep↔reconcile flip-flop) without stickiness. Unlike talent, its
// scraper's reconcile stays a full deactivator (complete category walk).
export const STICKY_SWEEP_DEAD_SOURCES = new Set(["talent", "allasportal"]);

// Sources fully excluded from the 404 sweep: their own detail-page URL can't be
// trusted with a plain GET, so the sweep would only ever produce false-positive
// kills — reconcileActive's full-listing walk already owns their active flag.
//   • LinkedIn: bot-blocked (no clean 404s), also shown time-based on the
//     frontend, so its `active` flag is irrelevant anyway.
//   • tudasdiak (2026-07-12): app.tudatosdiak.hu is an Inertia SPA whose detail
//     route 404s on a bare GET even for a LIVE posting (confirmed live on the
//     "Security Support Engineering Intern (IAM)" job — sweep killed it, the
//     hourly cron_jobs_DIAK_1 listing scrape resurrected it the same day, on
//     loop once per day right after the 14:00 UTC sweep). tudasdiak's listing
//     has <10 postings and its own reconcileActive already tracks it fully.
export const SWEEP_EXCLUDED_SOURCES = new Set(["LinkedIn", "tudasdiak"]);

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
// talent: the visible "no longer accepting applications" banner is rendered
// from the job object's `system_status` (2 = expired, 1 = live) in the
// Next.js flight payload. The page embeds SEVERAL job objects (related jobs
// too!), so the status MUST be read from the object anchored at the url's own
// id — a global regex grabs some other job's status. Validated 2026-07-06 on
// 14/14 browser-rendered truth pages; purged jobs turn HTTP 404 (plain rule
// catches those). Missing anchor/field → fail-safe alive. Secondary signal:
// when talent SSR-renders the banner (2026-07-01 behaviour), it appears as
// element text `>Már nem fogadnak…<` — the i18n dict form is always
// `:"Már nem fogadnak…"`, so the tag boundary keeps it false-positive-free.
//
// REGRESSION found 2026-07-30: talent silently switched the SSR banner from
// Hungarian to English at some point after the 07-06 validation (our sweep
// still sends `Accept-Language: hu-HU,hu;q=0.9,en;q=0.8`, so it's talent's
// own locale choice, not a header problem on our end) — two jobs the user
// flagged as visibly showing "No longer accepting applications" produced
// ZERO matches on the Hungarian regex, so they sat active indefinitely.
// Confirmed via a live control job (a currently-listed talent posting) that
// the rendered `>No longer accepting applications<` span is genuinely
// absent when live and present (exactly once, as a real element — not the
// i18n dict copy) on both flagged dead postings. Added as a second
// tag-boundary-anchored check, same false-positive-safe shape as the
// Hungarian one, so whichever language talent actually serves gets caught.
export const BANNER_DEAD_SOURCES = {
  bluebird: "az álláshirdetés lejárt",
  talent: (row, body) => {
    if (/>\s*Már nem fogadnak jelentkezéseket\s*</i.test(body)) return true;
    if (/>\s*No longer accepting applications\s*</i.test(body)) return true;
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

  // Added 2026-07-22, each validated by fetching a currently-active listed job
  // for that exact source and confirming the phrase is ABSENT (the project's
  // repeated "SPA template noise" trap — see the doc comment above and
  // qdiak's entry below for why that check matters).
  schonherz: "sajnos ez a hirdetés már nem aktuális",
  minddiak: "ez az álláshirdetés már nem érhető el",
  miszisz: "lejárt a jelentkezési",
  // melodiak's plain phrase ("Lezárt hirdetés") is ALSO baked into every page
  // as i18n props JSON (`"section3":{"text1":"Lezárt hirdetés",...}`, present
  // whether the job is open or closed) — same trap as qdiak. The reliable
  // signal is the actual server-rendered banner element, confirmed present
  // only on a dead page and absent on a live one (2026-07-22, live sample
  // fetched fresh from web-api.melodiak.hu's own listing since no active row
  // existed in job_posts to test against at the time).
  melodiak: "<h3>lezárt hirdetés</h3>",
  mbh: "a keresett álláshirdetés nem található",
  "cg-jobstream": "position has been filled",
  wise: "job has expired",
  // dreamjobs shows the full posting (title/description/apply button) even
  // when expired — SEO pattern, same idea as nofluffjobs — but adds an
  // explicit expiry line the live-page check confirmed is absent otherwise.
  dreamjobs: "már lejárt",
  // kuka/cg-jobstream/wise's ATS renders in the visitor's locale, so both an
  // English and a German "closed" string were seen live; checking either
  // covers kuka specifically (cg-jobstream/wise only showed the English one).
  kuka: (row, body) => {
    const lower = body.toLowerCase();
    return lower.includes("position has been filled") || lower.includes("job has expired") || lower.includes("bereits besetzt");
  },
  // qdiak's own phrase ("Ez az állás már nem elérhető") is NOT safe as a plain
  // substring — confirmed live 2026-07-22 that it's baked into every page as
  // the disabled-apply-button's i18n dict entry
  // (`"application":{"button":{"inactive":"Ez az állás már nem elérhető",...`),
  // present whether the job is open or closed. The reliable signal instead is
  // the job's OWN campaign status, anchored by its id (same pattern as
  // talent's system_status): `"id":"{uuid}","kampany":{...,"statusz":"aktiv"}`
  // on a live job vs `"statusz":"szunetel"` (or any other non-"aktiv" value)
  // on a dead one — validated against one confirmed-live and one
  // confirmed-dead posting.
  qdiak: (row, body) => {
    const id = (row.url.match(/\/munkak\/([0-9a-f-]{36})/i) || [])[1];
    if (!id) return false;
    // Next.js flight payload ships this as backslash-escaped JSON; fall back
    // to the plain form too (mirrors talent's rule, same underlying reason).
    // Verified 2026-07-22 against one confirmed-live page (statusz:"aktiv")
    // and one confirmed-dead page (statusz:"szunetel").
    let i = body.indexOf(`\\"id\\":\\"${id}\\",\\"kampany\\"`);
    if (i < 0) i = body.indexOf(`"id":"${id}","kampany"`);
    if (i < 0) return false;
    const m = body.slice(i, i + 400).match(/statusz\\?"\s*:\s*\\?"([^"\\]*)/);
    return !!m && m[1] !== "aktiv";
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
 * SWEEP_EXCLUDED_SOURCES are skipped entirely — sources whose own detail-page
 * URL can't be trusted with a plain GET (see the constant's doc comment).
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
    `SELECT url, source FROM job_posts WHERE active = true AND NOT (source = ANY($1::text[]))`,
    [[...SWEEP_EXCLUDED_SOURCES]]
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
          AND NOT (source = ANY($2::text[]))
          AND url = ANY($1::text[])`,
      [confirmed, [...SWEEP_EXCLUDED_SOURCES]]
    );
    deactivated = res.rowCount ?? 0;
  }

  return { checked: rows.length, suspects: suspects.length, deactivated };
}

// How far back reviveSweepDead looks (by first_seen). Without a bound it would
// re-fetch EVERY row the sweep ever killed, every day, forever — a cost that only
// grows. A posting that first appeared over a month ago and is dead is not coming
// back; the false-kill window we actually care about is days, not months.
export const REVIVE_MAX_AGE_DAYS = 45;

// Sources whose reconcileActive is hardcoded reactivate-only (`complete:false`),
// i.e. their LISTING can never deactivate anything — the 404-sweep is their SOLE
// deactivator. For these, an inactive row means "the sweep killed it" no matter what
// `sweep_dead` says, so reviveSweepDead re-checks ALL their inactive rows, not just
// the flagged ones. That is what heals rows killed by an OLDER, since-fixed reconcile:
// they carry sweep_dead=false and are otherwise unreachable forever, because the ad has
// long since aged out of the listing that would have reactivated it (2026-07-14: 7 live
// profession-intern rows sat off exactly like this, invisible to every automatic path).
//
// Safe only because each of these four has an authoritative per-url death rule
// (profession-intern → REDIRECT_DEAD_SOURCES; talent/nofluffjobs/bluebird →
// BANNER_DEAD_SOURCES), so "no death signal on its own page" really does mean alive,
// and because their reconcile cannot re-deactivate what this revives (no flip-flop).
//
// ⚠️ Do NOT add a source here whose rows can be deactivated on PURPOSE (policy), e.g.
// out-of-scope-location rows: they are ALIVE at their url, so this would resurrect them
// every day. Such rows must be DELETED instead (profession's non-Budapest purge does).
// startupjobs (2026-07-28): api.startup.jobs/v1/jobs only returns postings
// PUBLISHED in the last 14 days — a time window, not a full current listing —
// so absence from it never proves a job closed (same reasoning as talent's
// rotating search results). Its scraper reconciles reactivate-only
// (complete:false); the 404 sweep's default plain-404 rule is its only
// deactivator. That default is UNVERIFIED here (no confirmed-dead posting
// checked yet) — if rows stay stuck active well past closing, check a known-
// dead startup.jobs page and add a BANNER_DEAD_SOURCES / REDIRECT_DEAD_SOURCES
// entry instead.
export const SWEEP_SOLE_DEACTIVATOR_SOURCES = new Set([
  "profession-intern",
  "talent",
  "nofluffjobs",
  "bluebird",
  "startupjobs",
]);

/**
 * Revives sweep kills that no longer hold up — the "and what if I was wrong?"
 * counterpart of sweepActive404.
 *
 * Runs for EVERY sweep-eligible source, not just the sticky ones. It keys strictly
 * on `sweep_dead`, i.e. rows the sweep itself killed at their OWN url (double-checked
 * at the time), so it re-asks exactly the question it once answered wrong. Rows that
 * reconcileActive deactivated (listing absence) or that were switched off by hand /
 * by policy carry sweep_dead=false and are never touched — that separation is what
 * makes running this across all sources safe.
 *
 * Why it can't stay sticky-only (measured 2026-07-14): 10 talent and 7 profession-intern
 * rows were equally alive by their own url's rules; the 14:00 sweep revived all 10 talent
 * rows and left all 7 profession-intern rows dead, purely because talent is in
 * STICKY_SWEEP_DEAD_SOURCES. Every non-sticky source's false kills were permanent —
 * as when the latin1 Location bug killed 13 live alllocaljobs rows (2026-07-10) and
 * nothing brought them back. See FALSE_DEACTIVATION_CHECK_2026-07-14.md.
 *
 * The original sticky motivation still holds and is subsumed: talent can flip the SAME
 * url's status back to alive (system_status 2→1, expire → re-list with no URL change),
 * which used to leave it stuck inactive forever even though the exact signal that killed
 * it now says alive (2026-07-12, confirmed on 2 user-reported urls).
 *
 * Revivals are double-checked (mirrors sweepActive404's own re-check) so a transient
 * blip can't resurrect a genuinely dead row.
 *
 * @param {import("pg").PoolClient} client
 * @param {(url: string, opts?: {wantBody?: boolean}) => Promise<{status:number, finalUrl:string|null, body?:string}>} checkFinal
 * @param {object} [opts]
 * @param {number} [opts.concurrency=12]
 * @param {number} [opts.maxAgeDays=REVIVE_MAX_AGE_DAYS]
 * @returns {Promise<{checked:number, revived:number}>}
 */
export async function reviveSweepDead(client, checkFinal, opts = {}) {
  const concurrency = Math.max(1, opts.concurrency ?? 12);
  const maxAgeDays = opts.maxAgeDays ?? REVIVE_MAX_AGE_DAYS;

  await ensureActiveSchema(client);

  const { rows } = await client.query(
    `SELECT url, source FROM job_posts
      WHERE active = false
        AND (sweep_dead = true OR source = ANY($3::text[]))
        AND NOT (source = ANY($1::text[]))
        AND first_seen >= NOW() - make_interval(days => $2::int)`,
    [[...SWEEP_EXCLUDED_SOURCES], maxAgeDays, [...SWEEP_SOLE_DEACTIVATOR_SOURCES]]
  );
  if (rows.length === 0) return { checked: 0, revived: 0 };

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

  // Negative statuses (local failure) never count as "alive" — only a real
  // response that fails every dead-rule is a revival candidate.
  const candidates = rows.filter((r) => {
    const res = results.get(r.url);
    return !!res && res.status >= 0 && !_isDeadResult(r, res);
  });

  const confirmed = [];
  for (const row of candidates) {
    const res = await checkFinal(row.url, wantBody(row));
    if (res && res.status >= 0 && !_isDeadResult(row, res)) confirmed.push(row);
  }

  let revived = 0;
  if (confirmed.length) {
    const urls = confirmed.map((r) => r.url);
    const res = await client.query(
      `UPDATE job_posts
          SET active = true, sweep_dead = false
        WHERE active = false
          AND (sweep_dead = true OR source = ANY($3::text[]))
          AND NOT (source = ANY($2::text[]))
          AND url = ANY($1::text[])`,
      [urls, [...SWEEP_EXCLUDED_SOURCES], [...SWEEP_SOLE_DEACTIVATOR_SOURCES]]
    );
    revived = res.rowCount ?? 0;
    for (const source of new Set(confirmed.map((r) => r.source))) {
      logRecovery({
        type: "sweep-revived",
        source,
        urls: confirmed.filter((r) => r.source === source).map((r) => r.url),
      });
    }
  }

  return { checked: rows.length, revived };
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

/**
 * Cleans up orphaned duplicate rows left behind by `migrateVolatileUrl`'s own
 * safety guard: when a stable-id source (erste/kh/otp — same jsbq-family ATS,
 * `VOLATILE_URL_PATTERNS`) gets re-slugged TWICE before the first stale row's
 * migration runs, `migrateVolatileUrl` refuses to rename into a url that
 * already has a row (its `NOT EXISTS` guard), so the older-slug row is left
 * behind — inactive (reconcile ages it out normally), but permanently orphaned
 * instead of merged. The job itself is NOT missing: a fresh row for the new
 * slug already exists and is active. Found live 2026-07-22 auditing "wrongly
 * deactivated" jobs — three flagged rows (erste `frontend-fejleszto-8899`, kh
 * `sre-support-engineer-15192`, otp reqId 1392573833 ×2) were exactly this:
 * harmless historical clutter that LOOKS like a false deactivation from
 * outside, not an actual bug — the frontend was already showing the job
 * correctly via the sibling row the whole time.
 *
 * Deletes an inactive row ONLY when another row of the same `source` shares
 * its stable id AND that other row is active — i.e. only when the job is
 * PROVABLY still correctly represented elsewhere. Never touches a group where
 * every row is inactive (that's just a genuinely closed job's slug history,
 * not a duplicate to clean up).
 *
 * @param {import("pg").PoolClient} client
 * @param {string} source
 * @param {(url: string) => string|null} extractStableId  pulls the platform's
 *   stable numeric id out of a url; returning null excludes that row from
 *   grouping entirely (never deleted).
 * @returns {Promise<{deleted: number}>}
 */
export async function pruneStaleIdDuplicates(client, source, extractStableId) {
  const { rows } = await client.query(
    `SELECT id, url, active FROM job_posts WHERE source = $1`,
    [source]
  );

  const byStableId = new Map();
  for (const row of rows) {
    let stableId;
    try {
      stableId = extractStableId(row.url);
    } catch {
      stableId = null;
    }
    if (!stableId) continue;
    if (!byStableId.has(stableId)) byStableId.set(stableId, []);
    byStableId.get(stableId).push(row);
  }

  const toDelete = [];
  for (const group of byStableId.values()) {
    if (group.length < 2) continue;
    if (!group.some((r) => r.active)) continue; // no active sibling — not our call
    for (const r of group) if (!r.active) toDelete.push(r.id);
  }

  if (toDelete.length === 0) return { deleted: 0 };
  const res = await client.query(`DELETE FROM job_posts WHERE id = ANY($1::int[])`, [toDelete]);
  return { deleted: res.rowCount ?? 0 };
}
