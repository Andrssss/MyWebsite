// netlify/functions/_dupe_snapshot.mjs
//
// Daily Blob snapshot of the rows the dupe guards need — added 2026-09-04.
//
// loadSameSourceDupeIndex (_active_core.mjs) and loadCrossSourceDupeIndex
// (_cross_source_dupe.mjs) used to run a full job_posts query — one source or
// the whole CROSS_SOURCE_DUPE_SOURCES whitelist — on EVERY scraper run that
// needs a dupe check (nofluffjobs/startupjobs/LinkedIn/profession-intern for
// same-source; startupjobs/ats-crawl/workable for cross-source), several
// times an hour. Almost all of that data is postings from BEFORE today, which
// barely changes run to run. cron_dupe_snapshot.mjs now writes it ONCE a day
// (23:45 UTC, after the day's scraping is done) into this store, holding only
// the columns dedup actually compares — never the full job_posts row.
//
// Callers read the blob instead of the DB, then run one small top-up query
// (indexed by first_seen, cheap) for whatever was inserted SINCE the
// snapshot, so correctness across the rest of the day is unaffected. A
// missing/corrupt blob, or a source the snapshot doesn't cover (not yet in
// CROSS_SOURCE_DUPE_SOURCES when it was written), falls back to the original
// full-scan query — this is a resource optimization, never allowed to
// silently reduce dedup coverage.
//
// 2026-09-16 (GH issue #18): the bank/single-company sources
// (SMALL_COMPANY_DUPE_SOURCES) post a handful of jobs a day at most, so the
// snapshot's whole rationale — skip a full-table scan on a HIGH-volume
// scraper's run — doesn't apply to them. Rather than fold their rows into the
// same Blob the big sources use, they get their own "dupe-snapshot-small"
// Blob, written/read in parallel with the big one and merged transparently in
// readDupeSnapshot() so loadCrossSourceDupeIndex/loadSameSourceDupeIndex don't
// need to know there are two underlying stores.
import { getStore } from "@netlify/blobs";
import { CROSS_SOURCE_DUPE_SOURCES, SMALL_COMPANY_DUPE_SOURCES } from "../../src/lib/crossSourceDupe.mjs";

const BIG_STORE_NAME = "dupe-snapshot";
const SMALL_STORE_NAME = "dupe-snapshot-small";
const SNAPSHOT_KEY = "latest.json";

// CROSS_SOURCE_DUPE_SOURCES already has the small sources spread into it (see
// crossSourceDupe.mjs) so every existing caller's `onlySources:
// CROSS_SOURCE_DUPE_SOURCES` keeps covering them — only the storage side
// needs to know which sources are "big" vs "small".
const BIG_SOURCES = CROSS_SOURCE_DUPE_SOURCES.filter((s) => !SMALL_COMPANY_DUPE_SOURCES.includes(s));

function store(name) {
  return getStore({ name, consistency: "strong" });
}

async function writeSnapshot(storeName, sources, client) {
  const generatedAt = new Date().toISOString();
  const { rows } = await client.query(
    `SELECT source, url, company, title, technologies, active
       FROM job_posts
      WHERE source = ANY($1::text[])
        AND company IS NOT NULL AND company <> ''
        AND title IS NOT NULL AND title <> ''`,
    [sources]
  );
  await store(storeName).setJSON(SNAPSHOT_KEY, { generatedAt, sources, rows });
  return { generatedAt, rowCount: rows.length };
}

export function writeDupeSnapshot(client) {
  return writeSnapshot(BIG_STORE_NAME, BIG_SOURCES, client);
}

export function writeSmallDupeSnapshot(client) {
  return writeSnapshot(SMALL_STORE_NAME, SMALL_COMPANY_DUPE_SOURCES, client);
}

async function readSnapshot(storeName) {
  try {
    const raw = await store(storeName).get(SNAPSHOT_KEY, { type: "json" });
    if (!raw || !Array.isArray(raw.rows) || !Array.isArray(raw.sources) || !raw.generatedAt) return null;
    return raw;
  } catch {
    return null;
  }
}

// Merges the big + small snapshots into the one shape callers already expect.
// If either half is missing/corrupt (e.g. the small store's first write
// hasn't happened yet), its sources are simply absent from the merged
// `sources` list, so snapshotCovers() correctly reports "not covered" for
// just that half and callers fall back to a live DB query for it — same
// fail-soft guarantee the single-store version had.
export async function readDupeSnapshot() {
  const [big, small] = await Promise.all([readSnapshot(BIG_STORE_NAME), readSnapshot(SMALL_STORE_NAME)]);
  const parts = [big, small].filter(Boolean);
  if (!parts.length) return null;
  return {
    generatedAt: parts.reduce((min, p) => (p.generatedAt < min ? p.generatedAt : min), parts[0].generatedAt),
    sources: parts.flatMap((p) => p.sources),
    rows: parts.flatMap((p) => p.rows),
  };
}

// True only when every source the caller needs was actually captured in the
// snapshot — a source outside CROSS_SOURCE_DUPE_SOURCES (e.g. a scraper that
// starts calling loadSameSourceDupeIndex before being added to the whitelist)
// must fall back to the DB rather than silently getting an empty index.
export function snapshotCovers(snapshot, sources) {
  if (!snapshot) return false;
  const covered = new Set(snapshot.sources);
  return sources.every((s) => covered.has(s));
}
