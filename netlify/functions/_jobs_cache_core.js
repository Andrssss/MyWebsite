// netlify/functions/_jobs_cache_core.js
//
// jobs.js keeps a per-warm-container in-memory cache of job listings (60s
// TTL). Hiding/unhiding a job (job-hidden.js, and job-applied.js's applied →
// hidden mirror) runs in its OWN, separate container/invocation and has no way
// to reach into jobs.js's cache Map directly — serverless containers don't
// share memory. So instead: every successful write to job_posts.hidden bumps a
// token here, and jobs.js compares it on every request, wiping its whole cache
// on a mismatch. A stale (pre-change) list can then never outlive the next
// request, regardless of the cache's own TTL.
//
// One module owns both the store name and the key name so the writer
// (bumpJobsCacheGeneration) and the reader (getJobsCacheGeneration) can't
// drift apart — the exact bug class that broke jobs.js's admin recognition
// after the ADMIN_1..4 rename (two copies of the same fact, one didn't move).
const { getStore } = require("@netlify/blobs");
const crypto = require("crypto");

const STORE_NAME = "jobs-cache-control";
const GEN_KEY = "gen";

// Call after any successful write to job_posts.hidden. Best-effort: a failure
// here means the NEXT hide/unhide's bump (or the cache's own 60s TTL) still
// catches it eventually, so this only degrades timing, not correctness.
async function bumpJobsCacheGeneration() {
  try {
    await getStore(STORE_NAME).set(GEN_KEY, crypto.randomUUID());
  } catch (err) {
    console.error("[jobs-cache] failed to bump cache generation:", err.message);
  }
}

// Call from jobs.js before serving from its in-memory cache. Throws on
// failure — jobs.js is the one deciding to fail open (skip invalidation for
// this request) rather than break the whole endpoint over a caching nicety.
async function getJobsCacheGeneration() {
  return getStore(STORE_NAME).get(GEN_KEY);
}

module.exports = { bumpJobsCacheGeneration, getJobsCacheGeneration };
