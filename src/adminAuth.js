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
