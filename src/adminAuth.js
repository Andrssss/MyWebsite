// Admin auth for the hidden job-watcher admin panels (Filters, Categories).
//
// The credential is a real server-side secret (Netlify env `ADMIN_SECRET`,
// falling back to `CRON_SECRET`) sent as `Authorization: Bearer <secret>`.
// It is NEVER committed to source — it lives only in the admin's browser
// localStorage after being entered once. This replaces the old model where a
// hardcoded, source-committed visitor UUID acted as the admin credential
// (public in the repo → anyone could purge the DB).

const KEY = "adminSecret";

export function getAdminSecret({ prompt = true } = {}) {
  let s = localStorage.getItem(KEY) || "";
  if (!s && prompt) {
    s = (window.prompt("Admin jelszó:") || "").trim();
    if (s) localStorage.setItem(KEY, s);
  }
  return s;
}

export function clearAdminSecret() {
  localStorage.removeItem(KEY);
}

function adminHeaders(extra = {}) {
  const s = getAdminSecret();
  return { ...extra, ...(s ? { Authorization: `Bearer ${s}` } : {}) };
}

// Drop-in replacement for fetch() on mutating admin calls: injects the bearer
// header and forgets a rejected secret so the next attempt re-prompts.
export async function adminFetch(url, options = {}) {
  const headers = adminHeaders(options.headers || {});
  const res = await fetch(url, { ...options, headers });
  if (res.status === 401) clearAdminSecret();
  return res;
}

// ── "Little admin" ─────────────────────────────────────────────────────────
// Read-only elevated access: jobs.js returns `hidden` rows when this device's
// visitor UUID matches one of the LITTLE_ADMIN* env vars. Same shape as the old
// ADMIN_VISITOR_IDS allowlist, except the accepted UUIDs live ONLY in the
// Netlify env — never in source, which is what makes them a credential at all.
// Nothing to set up per device: the visitor cookie already exists; you just
// paste the device's UUID into the Netlify env.
const VISITOR_COOKIE = "jobWatcherVisitorId";

// JobWatcher caches the job list in localStorage for 5 minutes under a key that
// does NOT encode admin-ness, so anything that changes what the server returns
// (e.g. toggling `hidden`) has to drop that cache, otherwise the board keeps
// serving the pre-change list for up to 5 minutes and looks broken.
export function purgeJobListCache() {
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("jobWatcherJobsCache_")) localStorage.removeItem(key);
    }
  } catch {
    // localStorage unavailable — the 5-min TTL will sort it out on its own.
  }
}

// This device's visitor UUID — the value to paste into a LITTLE_ADMIN* env var
// to grant this browser read access to hidden rows.
export function getDeviceVisitorId() {
  for (const part of document.cookie.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() !== VISITOR_COOKIE) continue;
    return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return "";
}

// NOTE: deliberately no `hasLittleAdminCookie()` helper here. Gating admin UI on
// the cookie's mere presence would let anyone reveal the controls by setting
// `jw_pref=anything` in devtools. JobWatcher instead derives admin-ness from the
// server's response (the `hidden` column, which jobs.js sends only to a verified
// little-admin), so the check cannot be spoofed client-side.
