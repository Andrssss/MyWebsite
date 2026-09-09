// netlify/functions/_subject_reviews_store.mjs
//
// subject_reviews moved from Postgres to Netlify Blobs (2026-09-08, user
// decision) — see CLAUDE.md "Where data lives" for the full rationale. Unlike
// the earlier blob migrations (job-stats, ats-state), this data is NOT
// derived/rebuildable and NOT low-concurrency: any visitor can create/edit/
// delete a review, and the new like feature means any visitor can write on
// every page view. A plain whole-blob read-modify-write (the pattern used by
// _daily_stats_store.mjs / _ats_state.mjs, which explicitly rely on "no
// concurrent writer") would lose updates here. So every write goes through
// `mutateReviews`, which does optimistic concurrency control via the
// `@netlify/blobs` etag/onlyIfMatch primitive: read the current blob + its
// etag, apply the mutation in memory, write back conditioned on that exact
// etag still being current, and retry from a fresh read if someone else wrote
// in between. This gives the same "no lost update" guarantee a Postgres row
// UPDATE would, without needing a database.
//
// ESM (.mjs) on purpose — this used to be CommonJS (_subject_reviews_store.js,
// "so both require() and import work"), but reviews.mjs importing it pulled
// in a NESTED `require("@netlify/blobs")` (this file, CJS) from inside an
// ESM entry point. esbuild bundles that as a synthetic `__require` shim
// that Netlify's Lambda runtime cannot resolve at runtime — confirmed live:
// "Cannot find module '@netlify/blobs'" thrown from exactly that require,
// even though every direct ESM `import { getStore } from "@netlify/blobs"`
// in this repo's other .mjs store modules works fine. Only ESM importers are
// left now (reviews.mjs, _backup-core.js), so there is no interop reason to
// stay CommonJS, and every reason not to.
//
// Store: "subject-reviews", single key "reviews.json":
//   { nextId, reviews: [{ id, name, user, difficulty, usefulness, general,
//     duringSemester, exam, year, semester, user_id, kepzes_fajtaja, likes }] }
// `likes` is the list of liker `user_id`s (the same localStorage id already
// used for edit/delete ownership) — never sent to clients as-is, only as a
// derived `likeCount` + `likedByMe` (see toPublicRow below), so one visitor's
// browser id can't be read off another visitor's like list.

import { getStore } from "@netlify/blobs";

export const STORE_NAME = "subject-reviews";
export const BLOB_KEY = "reviews.json";
const GENERAL_INFO_NAME = "általános információ";

function store() {
  return getStore({ name: STORE_NAME, consistency: "strong" });
}

function normalizeForCompare(name) {
  return String(name ?? "").trim().toLowerCase();
}

export async function readReviewsWithEtag() {
  // getWithMetadata returns null (not {data: null}) when the key doesn't
  // exist yet — the exact state before the one-time Postgres migration runs.
  const result = await store().getWithMetadata(BLOB_KEY, { type: "json" });
  const data = result?.data;
  if (!data || !Array.isArray(data.reviews)) {
    return { data: { nextId: 1, reviews: [] }, etag: null };
  }
  return { data, etag: result.etag };
}

// Applies `mutateFn` to the current data and writes it back, retrying on a
// concurrent-write conflict (etag mismatch) so no update is ever lost.
// `mutateFn` is a pure function: (data) => newData, and may throw to abort
// the whole operation (e.g. validation errors) without writing anything.
//
// maxRetries=20 + jittered backoff: a real burst of simultaneous likes/edits
// on this small site is a handful of visitors, not many — but a stress test
// with 20 truly-simultaneous writers (Promise.all, no real network delay
// between them) exhausted a maxRetries=5 loop with zero backoff every time
// (every attempt re-collided with every other attempt's fresh read). Backoff
// spreads retries out in time so they stop lock-stepping into the same
// collision, and 20 retries covers a much larger burst than this site will
// ever see in practice.
export async function mutateReviews(mutateFn, { maxRetries = 20 } = {}) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const { data, etag } = await readReviewsWithEtag();
    const next = mutateFn(data);
    const opts = etag ? { onlyIfMatch: etag } : { onlyIfNew: true };
    const { modified } = await store().setJSON(BLOB_KEY, next, opts);
    if (modified) return next;
    // Someone else wrote in between — back off a little, then retry against
    // the fresh state (re-read happens at the top of the next iteration).
    const backoffMs = Math.min(20 * 2 ** attempt, 300) * (0.5 + Math.random());
    await new Promise((resolve) => setTimeout(resolve, backoffMs));
  }
  throw new Error("Nem sikerült írni a subject-reviews blobba (túl sok ütközés).");
}

export function toPublicRow(review, viewerId) {
  const { likes, ...rest } = review;
  const likeList = Array.isArray(likes) ? likes : [];
  return {
    ...rest,
    likeCount: likeList.length,
    likedByMe: viewerId ? likeList.includes(viewerId) : false,
  };
}

// ── queries (1:1 port of the old SQL) ──────────────────────────────────────

// Mirrors: GROUP BY name ORDER BY (lower(btrim(name))='általános információ') DESC,
//          MIN(semester) NULLS LAST, name
function selectSubjectNamesOrdered(reviews) {
  const byName = new Map();
  for (const r of reviews) {
    const g = byName.get(r.name) || { name: r.name, minSemester: null };
    if (r.semester != null && (g.minSemester == null || r.semester < g.minSemester)) {
      g.minSemester = r.semester;
    }
    byName.set(r.name, g);
  }
  return [...byName.values()].sort((a, b) => {
    const aGeneral = normalizeForCompare(a.name) === GENERAL_INFO_NAME;
    const bGeneral = normalizeForCompare(b.name) === GENERAL_INFO_NAME;
    if (aGeneral !== bGeneral) return aGeneral ? -1 : 1;

    const aSem = a.minSemester;
    const bSem = b.minSemester;
    if (aSem == null && bSem != null) return 1; // NULLS LAST
    if (aSem != null && bSem == null) return -1;
    if (aSem != null && bSem != null && aSem !== bSem) return aSem - bSem;

    return a.name.localeCompare(b.name);
  });
}

// Mirrors: ORDER BY semester, name, id (Postgres ASC default = NULLS LAST)
function sortRows(reviews) {
  return [...reviews].sort((a, b) => {
    const aSem = a.semester;
    const bSem = b.semester;
    if (aSem == null && bSem != null) return 1;
    if (aSem != null && bSem == null) return -1;
    if (aSem != null && bSem != null && aSem !== bSem) return aSem - bSem;

    const nameCmp = String(a.name).localeCompare(String(b.name));
    if (nameCmp !== 0) return nameCmp;

    return a.id - b.id;
  });
}

// `limit` = distinct subject names (not rows) — see the old SQL's comment.
export function queryReviews(reviews, { limit } = {}) {
  if (!limit) return sortRows(reviews);

  const orderedNames = selectSubjectNamesOrdered(reviews).slice(0, limit).map((g) => g.name);
  const nameSet = new Set(orderedNames);
  return sortRows(reviews.filter((r) => nameSet.has(r.name)));
}

export async function getReviewById(id) {
  const { data } = await readReviewsWithEtag();
  return data.reviews.find((r) => r.id === id) || null;
}

export async function listReviews({ limit } = {}) {
  const { data } = await readReviewsWithEtag();
  return queryReviews(data.reviews, { limit });
}

// ── mutations ───────────────────────────────────────────────────────────

export async function createReview(fields) {
  let created;
  await mutateReviews((data) => {
    const id = data.nextId;
    created = { ...fields, id, likes: [] };
    return { nextId: id + 1, reviews: [...data.reviews, created] };
  });
  return created;
}

export async function updateReview(id, patch) {
  let updated = null;
  await mutateReviews((data) => {
    const idx = data.reviews.findIndex((r) => r.id === id);
    if (idx === -1) return data; // no-op write; caller checks `updated`
    updated = { ...data.reviews[idx], ...patch };
    const reviews = [...data.reviews];
    reviews[idx] = updated;
    return { ...data, reviews };
  });
  return updated;
}

export async function deleteReview(id) {
  let deleted = false;
  await mutateReviews((data) => {
    const next = data.reviews.filter((r) => r.id !== id);
    deleted = next.length !== data.reviews.length;
    if (!deleted) return data;
    return { ...data, reviews: next };
  });
  return deleted;
}

// Toggle: liking an already-liked review unlikes it. Always ends with at
// most one entry for `userId` in `likes`, regardless of how many times this
// races against itself — the retry loop in mutateReviews re-reads the fresh
// state each attempt, so a double-click just flips the state twice.
export async function toggleLike(id, userId) {
  let result = null;
  await mutateReviews((data) => {
    const idx = data.reviews.findIndex((r) => r.id === id);
    if (idx === -1) return data;
    const review = data.reviews[idx];
    const likes = Array.isArray(review.likes) ? review.likes : [];
    const alreadyLiked = likes.includes(userId);
    const nextLikes = alreadyLiked ? likes.filter((u) => u !== userId) : [...likes, userId];
    const reviews = [...data.reviews];
    reviews[idx] = { ...review, likes: nextLikes };
    result = { likeCount: nextLikes.length, likedByMe: !alreadyLiked };
    return { ...data, reviews };
  });
  return result; // null if the review doesn't exist
}
