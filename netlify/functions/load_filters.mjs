// job_filters moved to the "job-filters" Netlify Blob 2026-09-09 — see
// _job_filters_store.mjs and CLAUDE.md's "Where data lives".
import { listFilterWords } from "./_job_filters_store.mjs";

let cache = null;
let cacheTs = 0;
const TTL = 5 * 60 * 1000; // 5 perc

export async function loadFilters() {
  const now = Date.now();
  if (cache && now - cacheTs < TTL) return cache;

  const words = await listFilterWords();
  cache = words;
  cacheTs = now;
  return words;
}
