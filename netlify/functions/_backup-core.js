import { getStore } from "@netlify/blobs";
import { readReviewsWithEtag } from "./_subject_reviews_store.js";

const STORE_NAME = "weekly-backups";

// subject_reviews moved to the "subject-reviews" Blob 2026-09-08 (see
// _subject_reviews_store.js) — this snapshot now protects against an
// accidental bad write/deploy to THAT blob, not against Postgres going away.
// A live blob being "always current" doesn't remove the need for a
// point-in-time copy; it just changes what the copy is a copy of.
export async function runBackup(key, { returnContent = false } = {}) {
  const { data } = await readReviewsWithEtag();
  const rows = data.reviews;

  const store = getStore(STORE_NAME);

  const content = JSON.stringify(
    { exportedAt: new Date().toISOString(), rows },
    null,
    2
  );

  await store.set(key, content, {
    metadata: { table: "reviews" },
  });

  return returnContent ? { key, content } : { key };
}

/**
 * List blobs in the backup store.
 * Returns an array of objects like: { key, metadata, lastModified, size } (shape can vary a bit)
 */
export async function listBackups({ prefix = "" } = {}) {
  const store = getStore(STORE_NAME);

  // Netlify Blobs list API supports prefix + pagination via cursor
  const out = [];
  let cursor = undefined;

  for (;;) {
    const res = await store.list({ prefix, cursor }); // { blobs: [], cursor?: string }
    const blobs = res?.blobs || res?.items || []; // defensive (API shape can differ by runtime version)
    out.push(...blobs);

    cursor = res?.cursor;
    if (!cursor) break;
  }

  return out;
}

export async function deleteBackup(key) {
  const store = getStore(STORE_NAME);
  await store.delete(key);
  return true;
}
