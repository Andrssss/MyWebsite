/*
  Cross-source duplicate guard — DB-backed half.

  The pure matching logic (dedupe key, normalization, the source whitelist)
  lives in src/lib/crossSourceDupe.mjs so it's the same code the admin board's
  "Átfedés" badge uses (src/JobWatcher.jsx) — see that file's header for the
  full rationale and the whitelist. This file only adds the part that needs a
  DB client: building the comparison index and checking a candidate against it.

  2026-09-03: this is deliberately KEY-ONLY (title+company), no technology
  involved. A same-source technology check was added and removed the same
  day — extraction quality varies too much between different sites' templates
  to trust a cross-source tech comparison (multiple confirmed live
  near-misses: one source extracting 2-3 tags for a posting another source
  extracted 10+ for, sometimes not even a strict subset). Technology IS a
  trustworthy signal within a single source's own extraction — see
  isLikelySamePosting / technologiesExactMatch in src/lib/crossSourceDupe.mjs
  — but that is a same-source tool, not used here. Cross-source false
  positives from a generic title colliding with a different real posting
  (e.g. "DevOps Engineer" at a large BPO employer) are a known, accepted
  tradeoff of key-only matching — see cross-source-dupe-coverage memory.
*/

export {
  normalizeDupeTitle,
  normalizeDupeCompany,
  dupeKey,
  CROSS_SOURCE_DUPE_SOURCES,
} from "../../src/lib/crossSourceDupe.mjs";

import { dupeKey } from "../../src/lib/crossSourceDupe.mjs";
import { readDupeSnapshot, snapshotCovers } from "./_dupe_snapshot.mjs";

/*
  Build the lookup set from every row of every OTHER source (or, with
  `onlySources`, from just the given source list — always excluding
  `ownSource` even then, so a source can never dupe-match against its own
  rows).

  Scope is "every row still in job_posts", inactive ones included, on purpose:
  keying only on active rows would let a posting bounce back in the moment the
  employer-side source deactivates it, which is exactly the flip-flop churn
  _active_core.mjs exists to prevent. Rows inactive for 60+ days are already
  archived out of the table by cron_jobposts_cleanup.mjs, so this stays bounded
  on its own.
*/
// When `onlySources` is the shared whitelist (every current caller passes it),
// reads yesterday-and-before from the daily Blob snapshot (_dupe_snapshot.mjs)
// instead of scanning job_posts every run, then tops up with a small
// first_seen-indexed query for whatever arrived today — see that file's
// header. Falls back to the original full query whenever the snapshot is
// missing or doesn't cover the requested sources (e.g. no `onlySources`, or a
// source not yet in CROSS_SOURCE_DUPE_SOURCES when the snapshot was written).
export async function loadCrossSourceDupeIndex(client, ownSource, { onlySources } = {}) {
  if (onlySources) {
    const snapshot = await readDupeSnapshot();
    if (snapshotCovers(snapshot, onlySources)) {
      const wanted = new Set(onlySources);
      const index = new Set();
      for (const r of snapshot.rows) {
        if (r.source === ownSource || !wanted.has(r.source)) continue;
        const k = dupeKey(r.company, r.title);
        if (k) index.add(k);
      }
      const { rows: freshRows } = await client.query(
        `SELECT company, title
           FROM job_posts
          WHERE source = ANY($1::text[]) AND source <> $2 AND first_seen > $3
            AND company IS NOT NULL AND company <> ''
            AND title IS NOT NULL AND title <> ''`,
        [onlySources, ownSource, snapshot.generatedAt]
      );
      for (const r of freshRows) {
        const k = dupeKey(r.company, r.title);
        if (k) index.add(k);
      }
      return index;
    }
  }

  const { rows } = onlySources
    ? await client.query(
        `SELECT company, title
           FROM job_posts
          WHERE source = ANY($1::text[])
            AND source <> $2
            AND company IS NOT NULL AND company <> ''
            AND title IS NOT NULL AND title <> ''`,
        [onlySources, ownSource]
      )
    : await client.query(
        `SELECT company, title
           FROM job_posts
          WHERE source <> $1
            AND company IS NOT NULL AND company <> ''
            AND title IS NOT NULL AND title <> ''`,
        [ownSource]
      );
  const index = new Set();
  for (const r of rows) {
    const k = dupeKey(r.company, r.title);
    if (k) index.add(k);
  }
  return index;
}

// Rows with no company can never be compared (A_K / schönherz style anonymous
// clients) — those are kept, not dropped, so a missing company field can never
// silently delete coverage.
export function isCrossSourceDupe(index, company, title) {
  const k = dupeKey(company, title);
  return !!k && index.has(k);
}
