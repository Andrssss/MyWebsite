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
import { getStore } from "@netlify/blobs";
import { CROSS_SOURCE_DUPE_SOURCES } from "../../src/lib/crossSourceDupe.mjs";

const STORE_NAME = "dupe-snapshot";
const SNAPSHOT_KEY = "latest.json";

function store() {
  return getStore({ name: STORE_NAME, consistency: "strong" });
}

export async function writeDupeSnapshot(client) {
  const generatedAt = new Date().toISOString();
  const { rows } = await client.query(
    `SELECT source, url, company, title, technologies, active
       FROM job_posts
      WHERE source = ANY($1::text[])
        AND company IS NOT NULL AND company <> ''
        AND title IS NOT NULL AND title <> ''`,
    [CROSS_SOURCE_DUPE_SOURCES]
  );
  await store().setJSON(SNAPSHOT_KEY, { generatedAt, sources: CROSS_SOURCE_DUPE_SOURCES, rows });
  return { generatedAt, rowCount: rows.length };
}

export async function readDupeSnapshot() {
  try {
    const raw = await store().get(SNAPSHOT_KEY, { type: "json" });
    if (!raw || !Array.isArray(raw.rows) || !Array.isArray(raw.sources) || !raw.generatedAt) return null;
    return raw;
  } catch {
    return null;
  }
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
