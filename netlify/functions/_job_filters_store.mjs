// netlify/functions/_job_filters_store.mjs
//
// job_filters lives in the "job-filters" Netlify Blob now, not Postgres
// (2026-09-09) — see CLAUDE.md's "Where data lives". Writes are admin-only
// (ADMIN_SECRET-gated, filters.mjs) and low-frequency — one operator editing
// a keyword list, not public concurrent writers — so this uses the same
// plain whole-blob read-modify-write pattern as _ats_state.mjs, NOT
// _subject_reviews_store.mjs's etag/retry loop; that one exists specifically
// because ANY visitor can write a review on every page view. See that file's
// header for the fuller distinction — this migration is the "no concurrent
// writer" case.
//
// The Postgres `job_filters` table itself was left in place, unread/unwritten
// from here on — same caution as the job-stats/ats-state/subject-reviews
// migrations before it: drop it in a follow-up once this has run live a while.

import { getStore } from "@netlify/blobs";

const STORE_NAME = "job-filters";
const KEY = "filters.json";

function store() {
  return getStore({ name: STORE_NAME, consistency: "strong" });
}

// { nextId, words: [{id, word}] }
export async function readFilterState() {
  const raw = await store().get(KEY, { type: "json" });
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.words)) {
    return { nextId: 1, words: [] };
  }
  return { nextId: Number.isFinite(raw.nextId) ? raw.nextId : 1, words: raw.words };
}

export async function writeFilterState(state) {
  await store().setJSON(KEY, state);
}

// What the scrapers actually consume (load_filters.mjs) — just the words,
// order doesn't matter for matching.
export async function listFilterWords() {
  const { words } = await readFilterState();
  return words.map((w) => w.word);
}

// What the admin UI / audit-data.mjs consume — {id, word} rows, sorted for
// display the same way the old `ORDER BY word` did.
export async function listFilterRows() {
  const { words } = await readFilterState();
  return [...words].sort((a, b) => a.word.localeCompare(b.word, "hu"));
}

// Mirrors the old `INSERT ... ON CONFLICT (LOWER(word)) DO NOTHING RETURNING
// id, word`. Returns the new row, or null if a case-insensitive duplicate
// already exists (mutates `state` in place on success).
export function addFilterWord(state, word) {
  const lower = word.toLowerCase();
  if (state.words.some((w) => w.word.toLowerCase() === lower)) return null;
  const row = { id: state.nextId, word };
  state.words.push(row);
  state.nextId += 1;
  return row;
}

// Mirrors `DELETE FROM job_filters WHERE id = $1` — a no-op if the id doesn't
// exist, same as the old SQL (mutates `state` in place).
export function removeFilterWordById(state, id) {
  state.words = state.words.filter((w) => w.id !== id);
}
