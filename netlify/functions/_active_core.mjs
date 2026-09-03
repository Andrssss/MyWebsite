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
import { aiScrapedProbe, aiScrapedIsDead } from "./_ai_liveness.mjs";
import { dupeKey, technologiesExactMatch } from "../../src/lib/crossSourceDupe.mjs";

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
 * @param {string}  [opts.scopePrefix]  restrict EVERY write of this call to rows
 *   whose url starts with this prefix. Needed when ONE `source` value is fed by
 *   many independent full listings (the ATS crawl: one board per company, sharded
 *   across runs) — without it the second shard's reconcile would deactivate the
 *   first shard's finds, which is exactly the Cat-5 failure in DEACTIVATION_AUDIT.md
 *   (two scrapers reconciling one source wipe each other). With a prefix, a call can
 *   only ever touch rows under that one company's board, so shards are isolated by
 *   construction rather than by scheduling luck. Derive it from the urls actually
 *   returned (deriveScopePrefix in _ats_providers.mjs), never hardcode a host.
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
  // starts_with() rather than LIKE: no %/_ escaping to get wrong, and the prefix
  // is caller data. null → unscoped (every existing caller).
  const scopePrefix = typeof opts.scopePrefix === "string" && opts.scopePrefix ? opts.scopePrefix : null;
  const scoped = (paramIndex) => (scopePrefix ? `AND starts_with(url, $${paramIndex})` : "");

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
          AND first_seen < NOW() - make_interval(days => $2::int)
          ${scoped(3)}`,
      scopePrefix ? [source, graceDays, scopePrefix] : [source, graceDays]
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
        ${scoped(3)}
      RETURNING url`,
    scopePrefix ? [source, urls, scopePrefix] : [source, urls]
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
          AND url <> ALL($2::text[])
          ${scoped(4)}`,
      scopePrefix ? [source, urls, graceDays, scopePrefix] : [source, urls, graceDays]
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
            AND url = ANY($2::text[])
            ${scoped(3)}`,
        scopePrefix ? [source, dead, scopePrefix] : [source, dead]
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
        AND url <> ALL($2::text[])
        ${scoped(4)}`,
    scopePrefix ? [source, urls, graceDays, scopePrefix] : [source, urls, graceDays]
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

/**
 * Same purpose as migrateVolatileUrl, for sources whose url has NO stable
 * component to regex on — the whole path is an opaque per-request id (talent:
 * `/view?id=<digits>`, confirmed 2026-09-03 to change between two fetches of
 * the identical search page a few minutes apart, for the exact same listed
 * card — not just across genuine reposts). Correlates by (title, company)
 * instead: if `newUrl` isn't stored yet but an INACTIVE existing row for this
 * source has the same title+company under a DIFFERENT url that this run's
 * crawl did NOT also see, that row is renamed to `newUrl` in place rather
 * than inserted as a fresh duplicate. Deliberately restricted to inactive
 * victims only (2026-09-03, user correction): an ACTIVE row with the same
 * title+company might genuinely be a second, still-open posting (same
 * generic title, same employer, two concurrent openings) — merging into it
 * would silently destroy that second listing. An inactive victim is the safe
 * case: a previously-seen posting for this exact title+company is gone, and
 * the fresh crawl just found what looks like its replacement.
 *
 * @param {import("pg").PoolClient} client
 * @param {string} source
 * @param {string} newUrl        url built from the current listing
 * @param {string} title
 * @param {string|null} company
 * @param {string[]} currentUrls ALL urls seen on the source this run (a row
 *                                still listed must never be renamed away)
 * @returns {Promise<boolean>}   true if an old row was renamed to newUrl
 */
export async function migrateByTitleCompany(client, source, newUrl, title, company, currentUrls) {
  await ensureActiveSchema(client);
  const res = await client.query(
    `WITH victim AS (
        SELECT id, url FROM job_posts
         WHERE source = $1
           AND title = $2
           AND company IS NOT DISTINCT FROM $3
           AND active = false
           AND url <> $4
           AND url <> ALL($5::text[])
           AND NOT EXISTS (SELECT 1 FROM job_posts WHERE source = $1 AND url = $4)
         ORDER BY first_seen DESC
         LIMIT 1)
     UPDATE job_posts
        SET url = $4, active = true, sweep_dead = false
       FROM victim
      WHERE job_posts.id = victim.id
      RETURNING victim.url AS old_url`,
    [source, title, company ?? null, newUrl, (currentUrls || []).filter(Boolean)]
  );
  const migrated = (res.rowCount ?? 0) > 0;
  if (migrated) {
    logRecovery({
      type: "url-migrated",
      source,
      from: res.rows[0].old_url,
      to: newUrl,
      reason: "title+company match",
    });
  }
  return migrated;
}

/**
 * Companion to migrateByTitleCompany: true if an ACTIVE row already exists
 * for this source with the same title+company under a different url. The
 * caller should skip inserting a fresh row in that case — migrateByTitleCompany
 * deliberately won't merge into an active row (it might be a second, genuinely
 * concurrent posting), but that does NOT mean a plain insert is safe either:
 * for a source whose url is not a stable job identifier (see
 * migrateByTitleCompany's doc), a "new" url this close a match is far more
 * likely to be the same posting re-served under a fresh id than an actual
 * second opening — inserting would recreate the exact duplicate-row bug this
 * pair of functions exists to fix (2026-09-03 user correction).
 */
export async function hasActiveDuplicateByTitleCompany(client, source, newUrl, title, company) {
  await ensureActiveSchema(client);
  const { rowCount } = await client.query(
    `SELECT 1 FROM job_posts
      WHERE source = $1 AND title = $2 AND company IS NOT DISTINCT FROM $3
        AND active = true AND url <> $4
      LIMIT 1`,
    [source, title, company ?? null, newUrl]
  );
  return rowCount > 0;
}

/**
 * Same idea as hasActiveDuplicateByTitleCompany, for a source whose own
 * scraped title/company TEXT isn't byte-stable across re-postings (raw exact
 * string equality misses it) — confirmed live 2026-09-03 on LinkedIn: 8
 * duplicate pairs where the company text varies ("Kostal Global Business
 * Services Center" vs "Kostal Group") or the title spelling varies
 * ("front-end" vs "frontend"), none of which LinkedIn's own
 * canonicalizeLinkedInJobUrl (numeric-suffix-only stripping) could catch.
 *
 * Uses dupeKey (first-word company + accent/spelling-normalized title, see
 * src/lib/crossSourceDupe.mjs) instead of raw equality, batched into an index
 * ONCE per run — build with loadSameSourceDupeIndex, then call
 * findSameSourceDuplicate per candidate row (O(1) map lookup instead of a
 * query per item). A match still requires an EXACT technologies match
 * (technologiesExactMatch) before being trusted, same "same-source
 * extraction is internally consistent" reasoning as isLikelySamePosting.
 */
export async function loadSameSourceDupeIndex(client, source) {
  await ensureActiveSchema(client);
  const { rows } = await client.query(
    `SELECT url, company, title, technologies FROM job_posts
      WHERE source = $1 AND active = true
        AND company IS NOT NULL AND company <> ''
        AND title IS NOT NULL AND title <> ''`,
    [source]
  );
  const index = new Map();
  for (const r of rows) {
    const key = dupeKey(r.company, r.title);
    if (!key) continue;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(r);
  }
  return index;
}

// Returns the matching existing row ({url, technologies}) or null. Caller
// should also add the new item to the index once it's inserted (see
// _linkedin_core.mjs) so a second near-duplicate discovered later in the
// SAME run is caught too — the index is only seeded from the DB once.
export function findSameSourceDuplicate(index, newUrl, company, title, technologies) {
  const key = dupeKey(company, title);
  if (!key) return null;
  const candidates = index.get(key);
  if (!candidates) return null;
  return candidates.find((r) => r.url !== newUrl && technologiesExactMatch(r.technologies, technologies)) || null;
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
// pannondiak (2026-08-18): a dead/unknown job id 302-redirects to /error/nopage,
// which itself 302-redirects to / (home) — final path "/" always differs from
// the job's own path. A currently-listed job stays a plain 200 at its own path
// with zero redirects. Confirmed live: a fresh id pulled from the site's own
// search API right now (job 3556) loads 200 with no redirect, while the only
// pre-existing DB row (job 3517, still flagged active) redirects all the way to
// home — i.e. this activation audit finding IS a real stale-active row, not a
// false positive from a session/cookie gate (checked with and without cookies +
// Referer, same result both ways).
export const REDIRECT_DEAD_SOURCES = new Set(["ydiak", "eudiakok", "profession-intern", "wherewework", "pannondiak"]);

// Sources whose LISTING keeps showing already-closed jobs, so being in
// foundUrls does not prove a posting is live. For these, reconcileActive's
// reactivation skips rows the 404-sweep proved dead at their own detail page
// (sweep_dead=true) — without this the hourly crawl would resurrect every
// sweep kill and the pair would flip-flop daily. One-way by design: a
// sweep_dead row only returns via a url-identity migration (migrateVolatileUrl
// or, for talent, migrateByTitleCompany — new URL), which is fine — talent ids
// are single-use (reposts, or even a same-listing refetch, get a fresh id;
// see migrateByTitleCompany's doc comment) and purged ids stay 404.
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
//   • tudasdiak: REMOVED from this set 2026-08-27 — see below.
//
// tudasdiak was here from 2026-07-12 because app.tudatosdiak.hu's detail route
// 404'd a bare GET even for a LIVE posting. That was never the SPA's doing: the
// urls we were asking about were malformed. The detail url needs a `pj` prefix
// before the puuid, and the scraper built them without it until commit c46bcd7
// — so the sweep was 404-ing on urls that genuinely did not exist. Re-measured
// 2026-08-27: a live posting's own url answers 200 (pj6423282947), an unknown
// puuid answers 404 (pj6306719999), and a stale SLUG with the right puuid
// 302s to the canonical url and 200s — i.e. the only 404 left is a real one.
//
// Removing it matters because its own reconcileActive CANNOT be its safety net
// here: the source's IT facet (searchIndustry=7) legitimately drops to zero
// postings for stretches (the site's own facet counter says 0 right now), and
// reconcileActive deliberately no-ops on an empty result set — a blocked crawl
// and a genuinely empty listing look identical to it. With no sweep and no
// reconcile, a closed tudasdiak row stayed active forever; that is exactly what
// the user hit ("Cloud Engineer Intern", closed since at least 2026-08-27,
// still on the board). The BANNER_DEAD_SOURCES.tudasdiak rule below is what
// actually decides death now; the sweep just carries the question to it.
export const SWEEP_EXCLUDED_SOURCES = new Set(["LinkedIn"]);

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
  // talent (2026-08-06): confirmed live that GET can answer a perfectly alive
  // posting with HTTP 404 while still SSR-rendering the full page — same job
  // title/company/apply-CTA as a real 200, and the flight payload's own id
  // carries system_status:1 (their "live" flag). HEAD on the identical URL
  // returned 200. Control case: id 630535740167293230 ("Network Engineer",
  // H-Tech Supports, first_seen 2026-08-05) — the plain 404 rule below killed
  // it within hours despite it being genuinely live. _isDeadResult consults
  // this before trusting a bare 404 for sources listed here.
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
  // "AI-scraped" is one flat source spanning ~255 unrelated companies' own
  // career pages and ATS tenants, so — unlike every other entry here — it can
  // never be a plain-string rule: a phrase that means "closed" on one domain is
  // ordinary copy on another. It is also the only source where the sweep's
  // plain-404 rule is nearly useless: 745 of its 755 active rows answered HTTP
  // 200 on 2026-08-30, dead ones included, with exactly one hard 404 in the
  // whole bucket. The per-platform rule set (SmartRecruiters/Workday/Ashby/
  // Greenhouse/Lever APIs + host-scoped redirect and banner rules) therefore
  // lives in its own module; the original atj.graphisoft.com phrase from
  // 2026-07-30 is now one entry in its DEAD_PHRASES list.
  "AI-scraped": (row, body, res) => aiScrapedIsDead(row, body, res),
  // ats-crawl runs on the SAME platforms the AI bucket's rules were written for
  // (greenhouse / lever / ashby / smartrecruiters boards), so it reuses them
  // verbatim rather than growing a second, drifting copy.
  //
  // Why it needs the sweep at all, when it has a scoped reconcileActive
  // (2026-09-01): reconcile only deactivates when deriveScopePrefix resolves,
  // and it never deactivates off an EMPTY board. Both gaps are real and were
  // measured on the live bucket the same day — 41 of 150 active rows sat on
  // tenants whose Greenhouse board points at the company's own domain
  // (tulip.co/careers/…?gh_jid=), where no scope prefix can be derived, and
  // OPSWAT had additionally dropped to zero HU postings, so even a fixed prefix
  // would have had nothing to derive one FROM. Those rows had no deactivation
  // path whatsoever: their own pages answer 200 for a removed posting, so the
  // sweep's plain-404 default never fired either. 4 were provably dead
  // (Greenhouse per-job API 404) and had been sitting active for days.
  //
  // Safe to enable wholesale: replaying this exact rule set over all 150 active
  // rows on 2026-09-01 produced 4 death verdicts, every one of them confirmed
  // absent from its board's own API, and 0 on the other 146.
  "ats-crawl": (row, body, res) => aiScrapedIsDead(row, body, res),

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
  // mbh has TWO dead shapes and the plain string only ever caught the first.
  // 2026-08-26: a closed posting is served as the bare app shell — HTTP 200,
  // ~22.6 KB, an EMPTY <title>, and no "Jelentkezem" apply CTA anywhere. It
  // never contains the "nem található" phrase, so the string rule read it as
  // alive and the rows sat active past closing (2 found: JobAdvertisement/21994
  // and /22070). Measured on live vs dead vs a control:
  //   live 21634 / 21890 / 22215 → 223 / 140 / 51 KB, real <title>, "Jelentkezem" x4
  //   dead 21994 / 22070        → 22.6 KB, <title></title>, "Jelentkezem" x0
  //   made-up id 99999 (control) → identical to the dead shape
  // Both signals must be absent to call it dead, so if MBH ever renames the CTA
  // or starts emitting a title on the shell, the rule fails SAFE (alive) rather
  // than killing live rows. A transient blank page can't kill either: the sweep
  // re-checks every dead verdict once, and mbh is not a sole-deactivator source,
  // so a wrong kill still carries sweep_dead=true and reviveSweepDead undoes it
  // on the next run.
  mbh: (row, body) => {
    if (body.toLowerCase().includes("a keresett álláshirdetés nem található")) return true;
    const title = (body.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "";
    if (title.trim()) return false;
    return !/Jelentkezem/i.test(body);
  },
  "cg-jobstream": "position has been filled",
  wise: "job has expired",
  // dreamjobs shows the full posting (title/description/apply button) even
  // when expired — SEO pattern, same idea as nofluffjobs — but adds an
  // explicit expiry line the live-page check confirmed is absent otherwise.
  dreamjobs: "már lejárt",
  // startupjobs (2026-08-19): dead posting answers plain HTTP 200 with
  // `<h4>This job is no longer available</h4>` — never a 404, so the sweep's
  // default rule never caught it (see SWEEP_SOLE_DEACTIVATOR_SOURCES comment
  // above for the "UNVERIFIED" history this closes). Confirmed absent on a
  // live sample from the same session.
  startupjobs: "this job is no longer available",
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
  // tudasdiak (2026-08-27): app.tudatosdiak.hu is an Inertia SPA — the whole
  // page state ships in the `data-page` attribute of the root div, HTML-entity
  // escaped. A closed posting keeps HTTP 200 and still renders the full ad;
  // the only difference is that prop bag, which carries the page's OWN job
  // (there is exactly one `isDisabled` occurrence per page — `similarJobs`
  // objects don't have the field, so no related-job contamination like
  // talent/qdiak had). Measured on the user-reported "Cloud Engineer Intern"
  // (pj6306719691, banner "Erre a pozícióra már nem fogadunk új jelentkezőket
  // — a kiválasztás folyamatban"): isDisabled:true, isSelectionOnly:true,
  // closedBannerMessage non-null, availability_status "on-hold". Control on a
  // live posting (pj6423282947): isDisabled:false, closedBannerMessage:null —
  // i.e. `isDisabled":true` is present exactly once when dead and zero times
  // when alive, so the i18n-template trap that burned qdiak/melodiak doesn't
  // apply. Both the escaped and raw JSON forms are accepted because the
  // attribute is entity-escaped in the HTML but the same prop appears
  // unescaped in the Inertia XHR response.
  tudasdiak: (row, body) =>
    /isDisabled&quot;\s*:\s*true/i.test(body) || /"isDisabled"\s*:\s*true/i.test(body),
};

// Sources whose 404 status can't be trusted at face value: the origin
// occasionally answers a genuinely-live posting's exact GET with HTTP 404
// while still SSR-rendering the real page — same id, own body proves it's
// alive. When body is available (BANNER_DEAD_SOURCES already requests it)
// this predicate is checked BEFORE the blanket 404-is-dead rule; if it can't
// find the id in the body at all, that's a real purge and the plain 404 rule
// still applies untouched.
// talent (2026-08-06): see the dated comment on its BANNER_DEAD_SOURCES entry
// above for the control case that proved this.
export const SOFT_404_ALIVE_SOURCES = {
  talent: (row, body) => {
    const id = (row.url.match(/[?&]id=(\d+)/) || [])[1];
    if (!id) return false;
    let i = body.indexOf(`\\"id\\":\\"${id}\\"`);
    if (i < 0) i = body.indexOf(`"id":"${id}"`);
    if (i < 0) return false;
    const m = body.slice(i, i + 3000).match(/system_status\\?"\s*:\s*(\d+)/);
    return !!m && m[1] === "1";
  },
};

/**
 * Sources whose death question must be asked somewhere OTHER than the posting's
 * own public url, because that url cannot be fetched reliably. Each entry maps a
 * row to `{ url, headers, minIntervalMs }` (or null to fall back to `row.url`).
 *
 * startupjobs (2026-08-27): startup.jobs sits behind Cloudflare and answers a
 * plain GET with a 403 "Just a moment…" interstitial most of the time — measured
 * 3 of 8 sequential requests locally, and the sweep hits it at concurrency 12,
 * so far worse. A 403 is correctly a NON-verdict, which is why the (correct)
 * BANNER_DEAD_SOURCES.startupjobs rule added 2026-08-19 almost never got a body
 * to run against and confirmed-dead postings sat active for a month. The site's
 * own official REST API has no such gate and the scraper already holds a key:
 * `GET api.startup.jobs/v1/jobs/{id}` answers 200 with the job for a live
 * posting and a flat 404 for a closed one. Verified 2026-08-27 against the three
 * user-reported closed postings (8802122 / 8744978 / 8739390 — all 404, all
 * showing "This job is no longer available" on the site) and against live
 * controls pulled from the site's own Hungary listing (9023227 / 9100436 /
 * 9441132 — all 200).
 *
 * The 14-day publish window that makes the LIST endpoint useless for reconcile
 * does NOT apply to the single-job endpoint: 8985268 (published 2026-08-12,
 * 15 days old) still answers 200. Checked explicitly, because a windowed
 * single-job endpoint would have mass-deactivated every aged row.
 *
 * Rate limit is the catch — the free tier is 20 req/min and a 57-row sweep
 * pulled 37 × HTTP 429 in one burst. 429 is a non-verdict like 403, so it is
 * merely slow rather than wrong, but the paced lane below keeps it from
 * happening at all. No key → no override → the HTML banner rule stays in
 * charge, exactly as before.
 */
export const SWEEP_PROBE_OVERRIDES = {
  startupjobs: (row) => {
    const key = process.env.STARTUPJOBS_API_KEY;
    if (!key) return null;
    const id = (row.url.match(/-(\d+)(?:[/?#]|$)/) || [])[1];
    if (!id) return null;
    return {
      url: `https://api.startup.jobs/v1/jobs/${id}`,
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      minIntervalMs: 3200, // 20 req/min free tier, with headroom
    };
  },

  // AI-scraped (2026-08-30): not one site but ~255 hosts, so the override
  // dispatches on the ROW's host — Greenhouse / Lever / SmartRecruiters /
  // Workday get asked at their own public job APIs, everything else falls back
  // to the posting's own page (aiScrapedProbe returns null). See _ai_liveness.mjs
  // for why each endpoint is the right question to ask. No minIntervalMs: these
  // are unauthenticated per-job endpoints with no rate limit worth pacing for,
  // and ~150 rows in one sequential lane would dominate the sweep's runtime.
  "AI-scraped": aiScrapedProbe,

  // ats-crawl (2026-09-01): same platforms, same probes — see the matching
  // BANNER_DEAD_SOURCES entry for why this source needs the sweep despite
  // having its own scoped reconcile. Every ats-crawl row is a Greenhouse /
  // Lever / Ashby / SmartRecruiters posting, so in practice the fallback branch
  // (probe the row's own url) is only reached for a Greenhouse board that still
  // points at the company's own domain — which the crawler no longer stores,
  // see the canonical-url note in _ats_providers.mjs's greenhouse adapter.
  "ats-crawl": aiScrapedProbe,
};

/**
 * Where the sweep should actually ask about `row`. Exported so the repo's
 * maintenance scripts ask the same question prod asks — the same reason
 * isDeadResult/isAliveResult are exported (a hand-copied mirror drifts).
 *
 * `deadStatuses` is a narrow opt-in: HTTP statuses that are a positive DEATH
 * verdict *at this probe's endpoint only*. It exists for Workday, whose CXS
 * endpoint answers 403 for a posting that exists but is unpublished. 403 stays
 * a non-verdict everywhere else on purpose (it is what a bot block looks like),
 * so this must never be widened to a global rule — an endpoint only earns an
 * entry once its 403 has been cross-checked against that platform's own search.
 *
 * @returns {{url: string, headers: object|null, minIntervalMs: number, deadStatuses: number[], overridden: boolean}}
 */
export function sweepProbeFor(row) {
  const build = SWEEP_PROBE_OVERRIDES[row.source];
  const o = build ? build(row) : null;
  if (!o) return { url: row.url, headers: null, minIntervalMs: 0, deadStatuses: [], overridden: false };
  return {
    url: o.url,
    headers: o.headers ?? null,
    minIntervalMs: o.minIntervalMs ?? 0,
    deadStatuses: o.deadStatuses ?? [],
    overridden: true,
  };
}

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
  // Statuses the probe's OWN endpoint declares fatal (Workday CXS 403). Scoped
  // to overridden probes so it can never reinterpret a bot block on a public
  // posting page; see sweepProbeFor's doc comment.
  const probe = sweepProbeFor(row);
  if (probe.overridden && probe.deadStatuses.includes(res.status)) return true;
  if (res.status === 404) {
    const aliveRule = SOFT_404_ALIVE_SOURCES[row.source];
    if (aliveRule && typeof res.body === "string" && aliveRule(row, res.body)) {
      return false;
    }
    return true;
  }
  if (
    REDIRECT_DEAD_SOURCES.has(row.source) &&
    // The redirect rule compares the response's final path against the ROW's
    // own path, so it is meaningless when the probe deliberately asked a
    // different url (SWEEP_PROBE_OVERRIDES) — it would read every override
    // response as "landed somewhere else" = dead. No source is in both sets
    // today; this keeps that from becoming a silent mass-kill if one ever is.
    !SWEEP_PROBE_OVERRIDES[row.source] &&
    res.status >= 200 && res.status < 400 &&
    res.finalUrl
  ) {
    const a = _pathOf(row.url);
    const b = _pathOf(res.finalUrl);
    return a !== null && b !== null && a !== b;
  }
  const rule = BANNER_DEAD_SOURCES[row.source];
  if (rule && res.status === 200 && typeof res.body === "string") {
    // Function rules also get the raw result: AI-scraped needs finalUrl to
    // recognise the platforms that redirect a removed posting to their careers
    // root instead of 404ing. Older rules simply ignore the third argument.
    if (typeof rule === "function") {
      if (rule(row, res.body, res)) return true;
    } else if (res.body.toLowerCase().includes(rule)) {
      return true;
    }
  }
  return false;
}

// "Not dead" is NOT the same as "alive". sweepActive404 treats a negative status
// (local failure) and 403/429/5xx as a NON-VERDICT: no dead-rule fired, so it
// leaves the row alone — fail-safe, because the only thing it can do is kill.
// reviveSweepDead's mistake (found 2026-08-26) was reusing that same "no rule
// fired" as positive proof of life, so a bot-block or rate-limit RESURRECTED a
// genuinely dead row. Measured on startup.jobs: 3 of 8 plain sequential GETs
// answered 403 (the sweep hits it at concurrency 12, so far worse), which is
// exactly why that source had 0 inactive rows out of 48 ever recorded while two
// confirmed-dead postings sat active — the daily sweep killed them and the
// revive that runs seconds later brought them straight back. Reviving may only
// ever act on a REAL response from the posting's own page: HTTP 200–399 that
// fails every dead-rule. Anything else (403/429/5xx/-1/-2/-3) means "we could
// not ask", and the existing inactive flag stands until we can.
// Melyik forrásnál kell a válasz TÖRZSE is? Mindenhol, ahol valamelyik szabály a
// törzsre néz — a banner-szabályok ÉS a soft-404 "mégis él" szabályok is. Ma a
// SOFT_404_ALIVE_SOURCES egyetlen forrása (talent) amúgy is banner-es, tehát ez
// nulla plusz letöltés; a lényeg, hogy egy JÖVŐBELI soft-404-es forrás ne
// csendben banner nélkül maradjon — akkor a törzs hiányában a puszta 404
// azonnal halálnak olvasódna, pont amit a soft-404 szabály meg akar előzni.
function _needsBody(source) {
  return BANNER_DEAD_SOURCES[source] !== undefined || SOFT_404_ALIVE_SOURCES[source] !== undefined;
}

function _isAliveResult(row, res) {
  if (!res) return false;
  if (!(res.status >= 200 && res.status < 400)) return false;
  return !_isDeadResult(row, res);
}

// Exported ONLY so the repo's maintenance scripts (scripts/audit_all_sources.mjs,
// scripts/check_false_deactivations.mjs) can ask the exact question the scheduled
// sweep asks, instead of keeping their own hand-copied "pontos tükör" of the rules
// above. That mirror drifted and produced wrong findings: SOFT_404_ALIVE_SOURCES
// was added here 2026-08-06 and never made it into either copy, so every talent
// 404 read as dead in an audit even where prod would (correctly) call it alive
// — found 2026-08-26. A copy can drift from the original; the original cannot
// drift from itself.
export const isDeadResult = _isDeadResult;
export const isAliveResult = _isAliveResult;

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
/** One probe, routed through SWEEP_PROBE_OVERRIDES and asking for a body only
 *  where some rule actually reads one. */
function _probeOne(row, checkFinal) {
  const p = sweepProbeFor(row);
  return checkFinal(p.url, { wantBody: _needsBody(row.source), headers: p.headers });
}

/**
 * Fan out one probe per row.
 *
 * Rows whose source has NO probe override keep the original round-robin across
 * `concurrency` workers. Rows whose source HAS one are pulled out into a
 * separate lane per source, walked sequentially with `minIntervalMs` between
 * requests: the override endpoints are rate-limited APIs, not public pages, and
 * spraying them at concurrency 12 just converts every verdict into an HTTP 429
 * non-verdict (measured on startup.jobs: 37 of 57 rows in one burst). Those
 * lanes still run in parallel with the plain ones, so pacing one small source
 * doesn't stall the sweep.
 */
async function _probeAll(rows, checkFinal, concurrency) {
  const results = new Map();
  const plain = [];
  const pacedBySource = new Map();
  for (const row of rows) {
    // Only rows that actually ASK for pacing go into the sequential lane. An
    // override with minIntervalMs 0 (AI-scraped's public ATS endpoints) has no
    // rate limit to respect, and funnelling its ~150 rows through one lane
    // would make the sweep's runtime an order of magnitude worse for nothing.
    const p = SWEEP_PROBE_OVERRIDES[row.source] ? sweepProbeFor(row) : null;
    if (p && p.overridden && p.minIntervalMs > 0) {
      if (!pacedBySource.has(row.source)) pacedBySource.set(row.source, []);
      pacedBySource.get(row.source).push(row);
    } else {
      plain.push(row);
    }
  }

  const lanes = Array.from({ length: concurrency }, (_, i) =>
    plain.filter((_, idx) => idx % concurrency === i)
  ).map(async (list) => {
    for (const row of list) results.set(row.url, await _probeOne(row, checkFinal));
  });

  for (const [, list] of pacedBySource) {
    lanes.push((async () => {
      for (let i = 0; i < list.length; i++) {
        const row = list[i];
        const wait = sweepProbeFor(row).minIntervalMs;
        if (i > 0 && wait > 0) await new Promise((r) => setTimeout(r, wait));
        results.set(row.url, await _probeOne(row, checkFinal));
      }
    })());
  }

  await Promise.all(lanes);
  return results;
}

export async function sweepActive404(client, checkFinal, opts = {}) {
  const concurrency = Math.max(1, opts.concurrency ?? 12);

  await ensureActiveSchema(client);

  const { rows } = await client.query(
    `SELECT url, source FROM job_posts WHERE active = true AND NOT (source = ANY($1::text[]))`,
    [[...SWEEP_EXCLUDED_SOURCES]]
  );
  if (rows.length === 0) return { checked: 0, suspects: 0, deactivated: 0 };

  const results = await _probeAll(rows, checkFinal, concurrency);

  // Re-check first-pass dead verdicts once; only a still-dead row deactivates.
  const suspects = rows.filter((r) => _isDeadResult(r, results.get(r.url)));
  const confirmed = [];
  for (const row of suspects) {
    if (_isDeadResult(row, await _probeOne(row, checkFinal))) confirmed.push(row.url);
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
// (complete:false); the 404 sweep's default plain-404 rule USED TO be its only
// deactivator. 2026-08-19: confirmed that was insufficient — a dead posting
// answers HTTP 200 with `<h4>This job is no longer available</h4>`, never a
// plain 404, so the default rule never fired and rows sat stuck active past
// closing. Now covered by a BANNER_DEAD_SOURCES entry instead (verified
// absent on a live sample from the same run).
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
 * blip can't resurrect a genuinely dead row, and both checks demand a real
 * HTTP 200–399 from the posting's own page (see _isAliveResult) — a 403/429/5xx
 * is "we could not ask", never "it's back".
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

  const results = await _probeAll(rows, checkFinal, concurrency);

  const candidates = rows.filter((r) => _isAliveResult(r, results.get(r.url)));

  const confirmed = [];
  for (const row of candidates) {
    if (_isAliveResult(row, await _probeOne(row, checkFinal))) confirmed.push(row);
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

// pruneStaleIdDuplicates (erste/kh/otp/raiffeisen orphan-duplicate cleanup) was
// removed 2026-08-04 (user decision: scrapers may never DELETE from job_posts,
// only the admin-gated purge may). The orphaned inactive rows it used to
// remove are harmless clutter, not a functional bug — reconcileActive already
// marks them inactive via UPDATE, and the job stays correctly represented by
// its active sibling row either way.
