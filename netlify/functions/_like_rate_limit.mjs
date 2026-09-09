// netlify/functions/_like_rate_limit.mjs
//
// Server-side backstop for POST /reviews/:id/like, on top of SubjectInfo.jsx's
// client-side 1s-per-review cooldown. The client-side guard only stops
// accidental/deliberate button-mashing in the browser; anyone bypassing the
// UI (curl, a script) can still fire requests as fast as they want — the CAS
// retry loop in _subject_reviews_store.mjs keeps that correct (never double-
// counts a like), but each request still costs a Blobs read+write, so this
// caps the request RATE, not just the data outcome.
//
// Scoped per user_id, not globally: this endpoint has no real auth (user_id
// is client-supplied, same trust model as review edit/delete ownership
// elsewhere in this repo), so a determined caller can still get around this
// by rotating user_id values — this stops naive/careless spam from one
// identity, not a determined attacker. A GLOBAL counter (like
// _ai_rate_limit.mjs's, which is deliberately shared across one trusted
// token) would be wrong here: one spamming visitor would then also block
// every other visitor's genuine likes.
//
// Fixed 60s window, same "NOT atomic, accepted deliberately" reasoning as
// _ai_rate_limit.mjs: Blobs has no compare-and-set for a plain counter, so
// two requests landing in the same instant could both read the same count
// and overshoot the budget by a few. Fine for a rate limit — the failure
// mode is "a couple of extra requests get through", not a correctness bug.
//
// Reuses the "subject-reviews" store (this data belongs to that domain) under
// its own key, pruning expired per-user windows on every write so the blob
// stays bounded to users active in the last minute instead of growing
// forever as new localStorage-generated user_ids show up over the site's
// lifetime.

import { getStore } from "@netlify/blobs";

const STORE_NAME = "subject-reviews";
const KEY = "like-ratelimit.json";
const WINDOW_MS = 60 * 1000;

// Like-toggle requests one user_id may make per window, across ALL reviews
// (not per-review — a script bypassing the client's per-review cooldown could
// otherwise just target a different review id every time).
export const LIKE_LIMIT_PER_WINDOW = Number(process.env.LIKE_RATE_LIMIT || 20);

function store() {
  return getStore({ name: STORE_NAME, consistency: "strong" });
}

function isActive(entry, now) {
  return entry && typeof entry.windowStart === "number" && now - entry.windowStart < WINDOW_MS;
}

/**
 * Checks and (if allowed) consumes one request from userId's budget in one
 * step — there's no separate "check" the caller could skip the "consume" of,
 * so a rejected request never gets silently charged either.
 *
 * @returns {{allowed: true} | {allowed: false, resetInSeconds: number}}
 */
export async function checkAndConsumeLikeBudget(userId) {
  const now = Date.now();
  const raw = await store().get(KEY, { type: "json" });
  const byUser = raw && typeof raw === "object" ? raw : {};

  const pruned = {};
  for (const [id, entry] of Object.entries(byUser)) {
    if (isActive(entry, now)) pruned[id] = entry;
  }

  const existing = pruned[userId];
  const windowStart = existing ? existing.windowStart : now;
  const count = existing ? existing.count : 0;

  if (count >= LIKE_LIMIT_PER_WINDOW) {
    const resetInSeconds = Math.max(0, Math.ceil((windowStart + WINDOW_MS - now) / 1000));
    return { allowed: false, resetInSeconds };
  }

  pruned[userId] = { windowStart, count: count + 1 };
  await store().setJSON(KEY, pruned);
  return { allowed: true };
}

export function tooManyLikeRequests(resetInSeconds) {
  return new Response(
    JSON.stringify({
      error: "Túl sok lájkolás, próbáld később.",
      limit: LIKE_LIMIT_PER_WINDOW,
      retryAfterSeconds: resetInSeconds,
    }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Retry-After": String(resetInSeconds),
      },
    }
  );
}
