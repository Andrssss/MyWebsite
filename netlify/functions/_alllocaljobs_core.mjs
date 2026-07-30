// Shared session-aware fetch machinery for hu.alllocaljobs.com, used by both
// cron_jobs_ALLLOCALJOBS-background.mjs (hourly scrape) and
// cron_alllocaljobs_deepsweep-background.mjs (daily full dead-check) — kept
// in one place so a fix to either (the latin1/utf8 Location bug, cookie
// handling) can't drift between two copies.
//
// Detail pages (/állás-<token>) only render for a client carrying a session
// cookie: cookie-less, they 200-redirect to /állások?requested_vacancy_not_found=1
// — the SAME landing page a genuinely dead job also redirects to even WITH a
// session. So "redirects to that page" is only a trustworthy death signal
// when the fetch carried a real session; without one it proves nothing about
// live-vs-dead (see the background files' own headers for the fuller history).

export const BASE = "https://hu.alllocaljobs.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// Minimál cookie jar: egy hoszt, path/expiry nem érdekes — a PHP session
// cookie átvitele a cél a lapozáshoz és a detail oldalakhoz.
export function makeJar() {
  const store = new Map();
  return {
    absorb(res) {
      const set = res.headers.getSetCookie?.() ?? [];
      for (const c of set) {
        const [pair] = c.split(";");
        const eq = pair.indexOf("=");
        if (eq > 0) store.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
    },
    header() {
      return [...store.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    },
  };
}

// A Location fejlécben a szerver NYERS UTF-8 bájtokat küld (/állás), amit az
// undici latin1-ként ad vissza → a naiv new URL() dupla-encode-ol
// (%C3%83%C2%A1…) és 404 lesz (élőben megfigyelve 2026-07-10). A latin1→utf8
// visszafejtés helyreállítja; ha a roundtrip érvénytelen UTF-8-at jelez
// (U+FFFD), marad az eredeti string.
export function fixLocationEncoding(loc) {
  const decoded = Buffer.from(loc, "latin1").toString("utf8");
  return decoded.includes("�") ? loc : decoded;
}

// Redirect-követés kézzel, hogy a lánc KÖZBEN kapott set-cookie is a jarba
// kerüljön (a detail oldal pont így kap sessiont) — fetch redirect:"follow"
// ezt eldobná.
export async function fetchWithSession(url, jar, extraHeaders = {}) {
  let current = url;
  for (let hop = 0; hop < 6; hop++) {
    const headers = {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
      "Accept-Language": "hu-HU,hu;q=0.9,en;q=0.8",
      ...extraHeaders,
    };
    const cookie = jar.header();
    if (cookie) headers.Cookie = cookie;

    const res = await fetch(current, {
      redirect: "manual",
      headers,
      signal: AbortSignal.timeout(25000),
    });
    jar.absorb(res);

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get("location");
      if (!loc) throw new Error(`HTTP ${res.status} (no Location) for ${current}`);
      current = new URL(fixLocationEncoding(loc), current).toString();
      continue;
    }
    const body = await res.text();
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`HTTP ${res.status} for ${current}`);
    }
    return { body, finalUrl: current };
  }
  throw new Error(`Too many redirects for ${url}`);
}
