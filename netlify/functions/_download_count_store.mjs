// netlify/functions/_download_count_store.mjs
//
// Download counter for subject file folders (2026-09-10, user request) —
// same Blob + optimistic-concurrency pattern as the subject-review like
// counter (_subject_reviews_store.mjs / CLAUDE.md "subject-reviews" entry):
// downloads are public, concurrent writes (any visitor, any time), so a
// plain whole-blob read-modify-write could lose increments under a burst of
// simultaneous clicks — the etag/onlyIfMatch retry loop gives the same
// "no lost update" guarantee a Postgres row UPDATE would.
//
// Granularity is per-folder, not per-file (user decision): a subject's root
// Drive folder and each of its immediate (first-level) subfolders each get
// their own counter; downloads from anything nested deeper roll up into
// their first-level ancestor's count instead of getting a counter of their
// own. See SemesterPreview.jsx's `countKeyForStack`.
//
// Store: "download-counts", single key "counts.json":
//   { counts: { [driveFolderId]: number } }

import { getStore } from "@netlify/blobs";

export const STORE_NAME = "download-counts";
export const BLOB_KEY = "counts.json";

function store() {
  return getStore({ name: STORE_NAME, consistency: "strong" });
}

async function readCountsWithEtag() {
  const result = await store().getWithMetadata(BLOB_KEY, { type: "json" });
  const data = result?.data;
  if (!data || typeof data.counts !== "object" || data.counts === null) {
    return { data: { counts: {} }, etag: null };
  }
  return { data, etag: result.etag };
}

// Same retry-with-backoff shape as mutateReviews in _subject_reviews_store.mjs
// — see that function's comment for why maxRetries=20 with jittered backoff.
async function mutateCounts(mutateFn, { maxRetries = 20 } = {}) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const { data, etag } = await readCountsWithEtag();
    const next = mutateFn(data);
    const opts = etag ? { onlyIfMatch: etag } : { onlyIfNew: true };
    const { modified } = await store().setJSON(BLOB_KEY, next, opts);
    if (modified) return next;
    const backoffMs = Math.min(20 * 2 ** attempt, 300) * (0.5 + Math.random());
    await new Promise((resolve) => setTimeout(resolve, backoffMs));
  }
  throw new Error("Nem sikerült írni a download-counts blobba (túl sok ütközés).");
}

export async function getCounts() {
  const { data } = await readCountsWithEtag();
  return data.counts;
}

export async function incrementCount(folderId) {
  let count;
  await mutateCounts((data) => {
    const current = data.counts[folderId] || 0;
    count = current + 1;
    return { counts: { ...data.counts, [folderId]: count } };
  });
  return count;
}
