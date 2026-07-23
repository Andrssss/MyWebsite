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
// Read-only elevated access: the backend returns `hidden` job rows when this
// cookie matches the LITTLE_ADMIN env var. A SEPARATE, lower-privilege
// credential from the ADMIN_SECRET above on purpose — if it leaks, someone sees
// hidden ads, they cannot destroy data. It's a cookie (not a header) so the
// ordinary job-list request carries it automatically with no extra plumbing.
// Only the cookie NAME ships in the bundle; the value lives in the Netlify env
// and in this one browser.
const LITTLE_ADMIN_COOKIE = "jw_pref";

// JobWatcher caches the job list in localStorage for 5 minutes under a key that
// does NOT encode admin-ness. Toggling the mark therefore has to drop that cache,
// otherwise the board keeps serving the pre-toggle list (no hidden rows, or
// stale hidden rows) and the change looks broken for up to 5 minutes.
export function purgeJobListCache() {
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("jobWatcherJobsCache_")) localStorage.removeItem(key);
    }
  } catch {
    // localStorage unavailable — the 5-min TTL will sort it out on its own.
  }
}

export function markDeviceLittleAdmin(secret) {
  const value = String(secret ?? window.prompt("LITTLE_ADMIN kulcs:") ?? "").trim();
  if (!value) return false;
  const secureFlag = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie =
    `${LITTLE_ADMIN_COOKIE}=${encodeURIComponent(value)}` +
    `; path=/; max-age=31536000; SameSite=Lax${secureFlag}`;
  purgeJobListCache();
  return true;
}

export function clearDeviceLittleAdmin() {
  document.cookie = `${LITTLE_ADMIN_COOKIE}=; path=/; max-age=0; SameSite=Lax`;
  purgeJobListCache();
}

// NOTE: deliberately no `hasLittleAdminCookie()` helper here. Gating admin UI on
// the cookie's mere presence would let anyone reveal the controls by setting
// `jw_pref=anything` in devtools. JobWatcher instead derives admin-ness from the
// server's response (the `hidden` column, which jobs.js sends only to a verified
// little-admin), so the check cannot be spoofed client-side.
