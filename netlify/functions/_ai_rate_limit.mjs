// netlify/functions/_ai_rate_limit.mjs
//
// Hourly write budget shared by EVERY token-authenticated ai-scraped write path
// (ai-registry.mjs and ai-ingest.mjs). It must be shared: both endpoints accept
// the same bearer token, so a limit applied to only one of them would be
// bypassed by calling the other.
//
// Why this exists: the deterministic filters in _ai_ingest_core.mjs (IT title,
// senior blacklist, senior-by-years, company blocklist) stop *accidental* bad
// rows, but they're content filters — someone holding the token could craft
// titles that survive them. This caps the blast radius of a leaked token to a
// bounded number of rows per hour instead of an unbounded flood.
//
// Fixed hourly window rather than a sliding one: the legitimate caller is a
// routine that posts a handful of findings once every 5 hours, so precision at
// the window edge is worth nothing here, and a fixed window is one small
// read-modify-write instead of a growing timestamp list.
//
// NOT atomic: Netlify Blobs has no compare-and-set, so two writes landing in the
// same millisecond could both read the same count and overshoot the budget by a
// few. Accepted deliberately — at the real traffic level (one caller, one POST
// per 5h) a race is vanishingly unlikely, and the failure mode is "a few extra
// rows in one hour", not a bypass. Don't reuse this module for anything where an
// exact ceiling actually matters.

import { getStore } from "@netlify/blobs";

const STORE_NAME = "ai-scraped-registry";
const KEY = "ratelimit.json";

// Rows accepted per hour across all ai-scraped write endpoints combined.
export const HOURLY_LIMIT = Number(process.env.AI_INGEST_HOURLY_LIMIT || 10);

// A single request bigger than this is rejected outright, before any DB work —
// stops a huge payload from burning CPU/DB time just to be filtered away.
export const MAX_ROWS_PER_REQUEST = Number(process.env.AI_INGEST_MAX_ROWS || 100);

const WINDOW_MS = 60 * 60 * 1000;

function store() {
  return getStore({ name: STORE_NAME, consistency: "strong" });
}

async function readCounter() {
  const raw = await store().get(KEY, { type: "json" });
  const now = Date.now();
  if (!raw || typeof raw !== "object" || !raw.windowStart) {
    return { windowStart: now, count: 0 };
  }
  const started = new Date(raw.windowStart).getTime();
  // Window expired (or clock/blob weirdness) → start a fresh one.
  if (!Number.isFinite(started) || now - started >= WINDOW_MS) {
    return { windowStart: now, count: 0 };
  }
  return { windowStart: started, count: Number(raw.count) || 0 };
}

/**
 * How many rows this caller may still write in the current window.
 * Call BEFORE doing any DB work, then report back with consume().
 *
 * @returns {{ remaining: number, limit: number, resetInSeconds: number }}
 */
export async function checkBudget() {
  const { windowStart, count } = await readCounter();
  const resetInSeconds = Math.max(0, Math.ceil((windowStart + WINDOW_MS - Date.now()) / 1000));
  return {
    remaining: Math.max(0, HOURLY_LIMIT - count),
    limit: HOURLY_LIMIT,
    resetInSeconds,
  };
}

/**
 * Record rows actually written. Pass the real inserted count, not the submitted
 * count — rows the content filters dropped never reached the DB, so charging
 * the budget for them would let a noisy-but-legitimate run starve itself.
 */
export async function consume(rowsWritten) {
  const n = Math.max(0, Number(rowsWritten) || 0);
  if (n === 0) return;
  const { windowStart, count } = await readCounter();
  await store().setJSON(KEY, { windowStart: new Date(windowStart).toISOString(), count: count + n });
}

/** Standard 429 body/headers, so both endpoints answer identically. */
export function tooManyRequests(budget) {
  return new Response(
    JSON.stringify({
      error: "Rate limit exceeded",
      limit: budget.limit,
      remaining: 0,
      retryAfterSeconds: budget.resetInSeconds,
      hint: `The ai-scraped write budget is ${budget.limit} rows/hour across all endpoints.`,
    }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Retry-After": String(budget.resetInSeconds),
      },
    }
  );
}
