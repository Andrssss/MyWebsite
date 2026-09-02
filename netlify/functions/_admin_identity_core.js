// netlify/functions/_admin_identity_core.js
//
// 2026-09-01: the second, read-only "little admin" tier was REMOVED. It existed
// to let a device see `hidden` rows without holding a write credential, but the
// board became admin-only on 2026-08-25, so the two tiers had converged to the
// same page-level access anyway. There is now exactly one tier: ADMIN_*.
const crypto = require("crypto");

const VISITOR_COOKIE = "jobWatcherVisitorId";

function envKeys(pattern) {
  return Object.keys(process.env)
    .filter((k) => pattern.test(k))
    .sort()
    .map((k) => (typeof process.env[k] === "string" ? process.env[k].trim() : ""))
    .filter((v) => v.length > 0);
}

// Admins: ADMIN_1, ADMIN_2… — same UUIDs as the old committed
// ADMIN_VISITOR_IDS allowlist, now env-only. Share ONE applied-jobs bucket.
// Adding a device is an env change only: the regex discovers every ADMIN_<n>,
// so a misspelled name grants nobody access instead of silently becoming a key.
function adminKeys() {
  return envKeys(/^ADMIN_\d+$/);
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length || ba.length === 0) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// UUIDs are case-insensitive by spec, but an env var pasted with different
// letter casing than the cookie's own crypto.randomUUID() output used to
// fail the byte-exact safeEqual() silently — admin status just vanished,
// taking hidden-row visibility with it. ADMIN_SECRET (safeEqual directly,
// below) stays case-SENSITIVE on purpose — that's a real secret, not a UUID.
function safeEqualCaseInsensitive(a, b) {
  return safeEqual(String(a).toLowerCase(), String(b).toLowerCase());
}

// No early exit: every key is compared regardless of an earlier match, so
// which key matched isn't observable from response timing.
function matchesAny(value, keys) {
  if (!value) return false;
  let ok = false;
  for (const k of keys) {
    if (safeEqualCaseInsensitive(value, k)) ok = true;
  }
  return ok;
}

function readCookie(event, name) {
  const raw =
    (event.headers && (event.headers.cookie || event.headers.Cookie)) || "";
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(idx + 1).trim());
    } catch {
      return part.slice(idx + 1).trim();
    }
  }
  return "";
}

// Does this request's visitor cookie belong to an admin? Used by jobs.js to
// decide hidden-row visibility.
function isRecognizedAdmin(event) {
  const cookie = readCookie(event, VISITOR_COOKIE);
  if (!cookie) return false;
  return matchesAny(cookie, adminKeys());
}

// Which applied-jobs bucket does this request belong to?
//   'admin' → one of the ADMIN_* UUIDs (ONE shared bucket for all admins)
//   null    → the visitor cookie matches no admin
// Kept as a string rather than a boolean because it IS the stored `owner_key`
// column value in admin_applied_jobs; rows written by the removed 'little' tier
// are still in that table, simply no longer reachable by anyone.
function resolveOwnerKey(event) {
  const cookie = readCookie(event, VISITOR_COOKIE);
  if (!cookie) return null;
  return matchesAny(cookie, adminKeys()) ? "admin" : null;
}

function hasAdminSecret(event) {
  const expected = (process.env.ADMIN_SECRET || process.env.CRON_SECRET || "").trim();
  if (!expected) return false;
  const hdr =
    (event.headers && (event.headers.authorization || event.headers.Authorization)) || "";
  const token = hdr.replace(/^Bearer\s+/i, "").trim();
  return token.length > 0 && safeEqual(token, expected);
}

// Does this request come from someone allowed to use the job-board pages AT ALL?
// Since 2026-08-25 everything under /allasfigyelo is admin-only: ordinary
// visitors are bounced to pestidev.hu before any fetch fires, and this is the
// server-side half of that rule — a client-side redirect on its own would leave
// every endpoint openly callable by anyone who knows the URL.
//
// An admin cookie qualifies; an ADMIN_SECRET bearer also does, so the repo's
// own maintenance scripts (scripts/audit_all_sources.mjs,
// scripts/check_false_deactivations.mjs, ad-hoc curl checks) keep working
// without a browser cookie.
function hasJobBoardAccess(event) {
  return isRecognizedAdmin(event) || hasAdminSecret(event);
}

module.exports = {
  VISITOR_COOKIE,
  adminKeys,
  safeEqual,
  matchesAny,
  readCookie,
  isRecognizedAdmin,
  resolveOwnerKey,
  hasAdminSecret,
  hasJobBoardAccess,
};
