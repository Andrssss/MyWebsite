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
//
// LinkedIn never calls this (it only sees a recent window); it stays time-based
// on the frontend instead.

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
  if (urls.length === 0 || !complete) {
    return { deactivated: 0, skipped: true };
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
    skipped: false,
  };
}

/**
 * 404 sweep — the cross-source safety net for reconcileActive.
 *
 * reconcileActive only works when a scraper can enumerate its source's FULL
 * current listing. Windowed / synthetic-URL sources (RSS "latest N", hash URLs)
 * can't, so their dead jobs never fall out of the set. This sweep instead asks
 * each active job's OWN URL whether it still exists, and deactivates the ones
 * that return HTTP 404 (gone).
 *
 * Network-agnostic: the caller injects `checkStatus(url) => Promise<number>`
 * returning the final HTTP status (after redirects). Negative / non-404 values
 * are treated as "still alive" — only a real 404 proves the posting is gone.
 * Each 404 is re-checked once to drop transients before it deactivates.
 *
 * LinkedIn is excluded: bot-blocked (no clean 404s) and shown time-based on the
 * frontend, so its `active` flag is irrelevant.
 *
 * @param {import("pg").PoolClient} client
 * @param {(url: string) => Promise<number>} checkStatus
 * @param {object} [opts]
 * @param {number} [opts.concurrency=12]
 * @returns {Promise<{checked:number, first404:number, deactivated:number}>}
 */
export async function sweepActive404(client, checkStatus, opts = {}) {
  const concurrency = Math.max(1, opts.concurrency ?? 12);

  await ensureActiveSchema(client);

  const { rows } = await client.query(
    `SELECT url FROM job_posts WHERE active = true AND source <> 'LinkedIn'`
  );
  if (rows.length === 0) return { checked: 0, first404: 0, deactivated: 0 };

  // Round-robin the URLs across `concurrency` workers.
  const status = new Map();
  const lanes = Array.from({ length: concurrency }, (_, i) =>
    rows.filter((_, idx) => idx % concurrency === i)
  );
  await Promise.all(
    lanes.map(async (list) => {
      for (const { url } of list) status.set(url, await checkStatus(url));
    })
  );

  // Re-check first-pass 404s once; only a still-404 deactivates.
  const suspects = rows.filter((r) => status.get(r.url) === 404).map((r) => r.url);
  const confirmed = [];
  for (const url of suspects) {
    if ((await checkStatus(url)) === 404) confirmed.push(url);
  }

  let deactivated = 0;
  if (confirmed.length) {
    const res = await client.query(
      `UPDATE job_posts
          SET active = false
        WHERE active = true
          AND source <> 'LinkedIn'
          AND url = ANY($1::text[])`,
      [confirmed]
    );
    deactivated = res.rowCount ?? 0;
  }

  return { checked: rows.length, first404: suspects.length, deactivated };
}
