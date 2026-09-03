/*
  Cross-source duplicate guard — DB-backed half.

  The pure matching logic (dedupe key, normalization, the source whitelist,
  and the technology-overlap check) lives in src/lib/crossSourceDupe.mjs so
  it's the same code the admin board's "Átfedés" badge uses (src/JobWatcher.jsx)
  — see that file's header for the full rationale, the whitelist, and why a
  matching key alone isn't always enough (generic titles at big employers).
  This file only adds the part that needs a DB client: building the comparison
  index and checking a candidate against it.
*/

export {
  normalizeDupeTitle,
  normalizeDupeCompany,
  dupeKey,
  technologyOverlap,
  TECH_MATCH_THRESHOLD,
  CROSS_SOURCE_DUPE_SOURCES,
} from "../../src/lib/crossSourceDupe.mjs";

import { dupeKey, technologyOverlap, TECH_MATCH_THRESHOLD } from "../../src/lib/crossSourceDupe.mjs";

/*
  Build the lookup index from every row of every OTHER source (or, with
  `onlySources`, from just the given source list — always excluding
  `ownSource` even then, so a source can never dupe-match against its own
  rows). Keyed by dupeKey, each key maps to the technologies of every DB row
  that produced it (a key can have several rows behind it — see
  isCrossSourceDupe below for why that matters).

  Scope is "every row still in job_posts", inactive ones included, on purpose:
  keying only on active rows would let a posting bounce back in the moment the
  employer-side source deactivates it, which is exactly the flip-flop churn
  _active_core.mjs exists to prevent. Rows inactive for 60+ days are already
  archived out of the table by cron_jobposts_cleanup.mjs, so this stays bounded
  on its own.
*/
export async function loadCrossSourceDupeIndex(client, ownSource, { onlySources } = {}) {
  const { rows } = onlySources
    ? await client.query(
        `SELECT company, title, technologies
           FROM job_posts
          WHERE source = ANY($1::text[])
            AND source <> $2
            AND company IS NOT NULL AND company <> ''
            AND title IS NOT NULL AND title <> ''`,
        [onlySources, ownSource]
      )
    : await client.query(
        `SELECT company, title, technologies
           FROM job_posts
          WHERE source <> $1
            AND company IS NOT NULL AND company <> ''
            AND title IS NOT NULL AND title <> ''`,
        [ownSource]
      );
  const index = new Map();
  for (const r of rows) {
    const k = dupeKey(r.company, r.title);
    if (!k) continue;
    if (!index.has(k)) index.set(k, []);
    index.get(k).push(r.technologies);
  }
  return index;
}

// Rows with no company can never be compared (A_K / schönherz style anonymous
// clients) — those are kept, not dropped, so a missing company field can never
// silently delete coverage.
//
// `technologies` is OPTIONAL — ats-crawl calls this before its detail-page
// fetch (to skip the request entirely for a known dupe), so it has no
// technologies yet and deliberately keeps matching on the key alone, same as
// before 2026-09-03. startupjobs/workable already have technologies by the
// time they check, and pass them, getting the extra precision.
export function isCrossSourceDupe(index, company, title, technologies) {
  const k = dupeKey(company, title);
  if (!k) return false;
  const candidates = index.get(k);
  if (!candidates) return false;
  if (technologies === undefined) return true; // key-only, pre-2026-09-03 behavior
  return candidates.some((candidateTech) => {
    const overlap = technologyOverlap(technologies, candidateTech);
    return overlap === null || overlap >= TECH_MATCH_THRESHOLD;
  });
}
