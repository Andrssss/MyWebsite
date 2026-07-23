// netlify/functions/_admin_identity_core.js
//
// Shared identity resolution for the two admin tiers, used by jobs.js and
// job-applied.js. Centralized on purpose: each file used to keep its own copy
// of this env-var discovery regex, and they drifted — the 2026-07-23
// LITTLE_ADMIN_4..7 → ADMIN_1..4 rename broke jobs.js's copy while
// job-applied.js's (password-only) check kept working, silently, because
// nothing forced the two to agree. One copy can't drift from itself.
const crypto = require("crypto");

const VISITOR_COOKIE = "jobWatcherVisitorId";

function envKeys(pattern) {
  return Object.keys(process.env)
    .filter((k) => pattern.test(k))
    .sort()
    .map((k) => (typeof process.env[k] === "string" ? process.env[k].trim() : ""))
    .filter((v) => v.length > 0);
}

// Real admins: ADMIN_1, ADMIN_2… — same UUIDs as the old committed
// ADMIN_VISITOR_IDS allowlist, now env-only. Share ONE applied-jobs bucket.
function adminKeys() {
  return envKeys(/^ADMIN_\d+$/);
}

// Little admins: LITTLE_ADMIN, LITTLE_ADMIN_2… — read-only hidden-row tier.
// Each gets their OWN applied-jobs bucket, kept apart from the real admins'.
function littleAdminKeys() {
  return envKeys(/^LITTLE_ADMIN(_\d+)?$/);
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length || ba.length === 0) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// No early exit: every key is compared regardless of an earlier match, so
// which key matched isn't observable from response timing.
function matchesAny(value, keys) {
  if (!value) return false;
  let ok = false;
  for (const k of keys) {
    if (safeEqual(value, k)) ok = true;
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

// Does this request's visitor cookie belong to EITHER admin tier? Used by
// jobs.js to decide hidden-row visibility — both tiers see hidden rows there.
function isRecognizedAdmin(event) {
  const cookie = readCookie(event, VISITOR_COOKIE);
  if (!cookie) return false;
  return matchesAny(cookie, adminKeys()) || matchesAny(cookie, littleAdminKeys());
}

// Which applied-jobs bucket does this request belong to?
//   'admin'        → one of the real ADMIN_* UUIDs (shared bucket, all 4 admins)
//   'little:<uuid>' → a little-admin, own separate bucket (their own UUID)
//   null           → visitor cookie matches neither tier
function resolveOwnerKey(event) {
  const cookie = readCookie(event, VISITOR_COOKIE);
  if (!cookie) return null;
  if (matchesAny(cookie, adminKeys())) return "admin";
  if (matchesAny(cookie, littleAdminKeys())) return `little:${cookie}`;
  return null;
}

function hasAdminSecret(event) {
  const expected = (process.env.ADMIN_SECRET || process.env.CRON_SECRET || "").trim();
  if (!expected) return false;
  const hdr =
    (event.headers && (event.headers.authorization || event.headers.Authorization)) || "";
  const token = hdr.replace(/^Bearer\s+/i, "").trim();
  return token.length > 0 && safeEqual(token, expected);
}

module.exports = {
  VISITOR_COOKIE,
  adminKeys,
  littleAdminKeys,
  safeEqual,
  matchesAny,
  readCookie,
  isRecognizedAdmin,
  resolveOwnerKey,
  hasAdminSecret,
};
