// netlify/functions/_ai_liveness.mjs
//
// Liveness rules for the `AI-scraped` bucket, used by the daily 404 sweep
// (`sweepActive404` in _active_core.mjs) via SWEEP_PROBE_OVERRIDES and
// BANNER_DEAD_SOURCES["AI-scraped"].
//
// WHY THIS EXISTS (2026-08-30). Every other source in _active_core.mjs is one
// site, so one rule per source is enough. `AI-scraped` is not a site — it is
// ~255 different hosts the discovery routine happened to find, and its dead
// postings almost never 404: two full manual sweeps (08-28: 77/761, 08-30:
// 75/755) measured 745 of 755 rows answering HTTP 200, with exactly ONE hard
// 404 in the whole bucket. So the sweep's plain-404 rule can only ever catch
// ~1 row per pass, which is why the backlog rebuilt itself after each manual
// sweep. The verdict has to be asked per platform.
//
// Where the 08-30 deaths actually came from (75 rows), i.e. what this file has
// to cover to be worth anything:
//    19  SmartRecruiters  API 200 with active:false
//    17  Workday          wday/cxs 403 (16) / 404 (1)
//    10  Ashby            absent from board -> page collapses to a generic shell
//     9  redirect         -> careers root / lejart-allashirdetes
//     8  banner phrase    thyssenkrupp / ALDI-SuccessFactors / sonrisa
//     5  Greenhouse       per-job API 404
//     3  Lever            per-job API 404
//     4  one-offs         (join.com repost, listing-only) — NOT covered here
//
// 2026-09-08 additions (a fresh external audit surfaced these, each confirmed
// live against the posting's own url before being added, same rule as above):
// Workable's `not_found=true` redirect marker, cigpannonia.hu's soft-404
// (closes what used to be the one open "soft-404" gap above), a third
// karrierportal-style vanity host (alfa.hu), two single-tenant careers-root
// redirects (sagemcom.com, bca.hu), and one cross-domain banner phrase
// (swicon-jobs.com -> swicon.com "this job offer is no longer available").
// Still NOT covered: eightfold (ericsson/vodafone/morganstanley job + apply
// APIs still carry no status/active/expiry field, and the careers/search page
// exposes no discoverable listing API either — confirmed again this pass).
//
// 2026-09-09 follow-up on the two other gaps from the pass above:
// - bankmonitor.hu: now covered (see the DEAD_LANDINGS loop below) — a closed
//   posting 301s to a DIFFERENT specific /karrier/{slug}/ posting, which a
//   truly nonexistent slug does not do (plain 404 instead), so it's a
//   deliberate site-side redirect, not generic not-found handling.
// - hrmaster.hu: confirmed a genuine dead end, not just untried. Both known
//   per-job url patterns (.../JobAdvertisement/{id}/{slug}/allasok and
//   .../Position/{id}) render a byte-identical server-side shell for a real
//   id, a real id with a wrong slug, AND a completely made-up id (999999) —
//   the page is 100% client-rendered off cookies/session, and its bundled JS
//   exposes no public read API. No plain-HTTP signal exists here at all.
//
// 2026-09-09, later same day: Eightfold is NOT actually a dead end — the user
// caught a live-site false-negative (jobs.ericsson.com/careers/job/563121776360652,
// rendering a client-side-only "Már nem fogadnak jelentkezéseket." banner that
// no plain fetch of the page or the per-job API ever surfaces, confirming the
// header comment above). The job+apply APIs still carry no status field, but
// every Eightfold tenant checked (jobs.ericsson.com, jobs.vodafone.com) serves
// an UNAUTHENTICATED `/careers/sitemap.xml` listing every currently-open
// posting's own url (506 / 1143 entries respectively, single flat file, well
// under the sweep's body cap) — the Ericsson job above is confirmed absent
// from it. Unlike SmartRecruiters' listing (capped at 3000, explicitly not
// used for this reason), neither sitemap showed any sign of truncation or
// pagination (no `<sitemapindex>`), so presence/absence in it is trustworthy.
// Eightfold has no self-describing domain (each tenant is a custom domain, or
// occasionally `*.eightfold.ai` for smaller ones), so unlike Workday/Greenhouse/
// Lever this can't be a URL-pattern match — EIGHTFOLD_HOSTS below is a plain
// allowlist, extended by hand as the AI-discovery routine finds new tenants
// (same shape as SmartRecruiters' 3000-cap carve-out: a known, documented,
// manually-maintained exception, not a hidden one).
//
// EVERY rule below is the posting's own ATS answering about itself, never the
// scraper's own extraction logic re-run against a fresh fetch (CLAUDE.md's
// independent-verification rule). Each was validated on 2026-08-30 against live
// controls from the same platform, and the whole rule set was replayed offline
// over all 755 then-active rows before deploy: it reproduced 68 of the 75
// hand-confirmed deaths and fired on 0 of the 680 rows left alive.
//
// Fail-open everywhere: an unparseable url, an unknown host, a truncated body
// or an unexpected API shape yields NO verdict, and the row stays active.

// Eightfold tenants confirmed to expose `/careers/sitemap.xml` (see the header
// comment above). Add a host here once a new tenant's sitemap is confirmed
// live and unpaginated — do NOT add one on the strength of the URL alone.
const EIGHTFOLD_HOSTS = new Set(["jobs.ericsson.com", "jobs.vodafone.com"]);

/** Eightfold job id from a `/careers/job/{id}-{slug}` url, or null. */
function eightfoldJobId(pathname) {
  return (pathname.match(/\/careers\/job\/(\d+)/) || [])[1] ?? null;
}

/** Hosts whose posting-death question is answered by the platform's own API.
 *  Returns a SWEEP_PROBE_OVERRIDES descriptor, or null to ask the row's own url. */
export function aiScrapedProbe(row) {
  let u;
  try { u = new URL(row.url); } catch { return null; }
  const host = u.hostname.replace(/^www\./, "");
  const path = u.pathname;
  let m;

  // Eightfold — no per-job status field anywhere (job API, apply-redirect
  // target), so the probe is redirected to the tenant's own sitemap instead;
  // aiScrapedIsDead below checks the row's job id for presence in it.
  if (EIGHTFOLD_HOSTS.has(host) && eightfoldJobId(path)) {
    return { url: `https://${host}/careers/sitemap.xml` };
  }

  // Greenhouse — job-boards.greenhouse.io/{board}/jobs/{id}. The EU board host
  // (job-boards.eu.greenhouse.io) is served by the US API host; there is no
  // boards-api.eu.greenhouse.io. A closed posting is a flat 404.
  if (/(^|\.)greenhouse\.io$/.test(host) && (m = path.match(/^\/([^/]+)\/jobs\/(\d+)\/?$/))) {
    return { url: `https://boards-api.greenhouse.io/v1/boards/${m[1]}/jobs/${m[2]}` };
  }

  // Lever — jobs.lever.co/{account}/{uuid}. Closed posting = 404.
  if (host === "jobs.lever.co" && (m = path.match(/^\/([^/]+)\/([0-9a-f-]{30,})\/?$/i))) {
    return { url: `https://api.lever.co/v0/postings/${m[1]}/${m[2]}` };
  }

  // SmartRecruiters — jobs.smartrecruiters.com/{company}/{postingId}-{slug}.
  // An expired posting still answers 200; the verdict is the `active` field
  // (see aiScrapedIsDead). Deliberately NOT diffed against the company's board
  // listing: that API caps at 3000 postings, which false-positives whole large
  // tenants (BoschGroup) wholesale.
  if (host === "jobs.smartrecruiters.com" && (m = path.match(/^\/([^/]+)\/(\d+)/))) {
    return { url: `https://api.smartrecruiters.com/v1/companies/${m[1]}/postings/${m[2]}` };
  }

  // Workday — {tenant}.wdN.myworkdayjobs.com[/{locale}]/{site}/job/...
  // The CXS endpoint behind every Workday careers SPA answers 200 for a live
  // posting and 403 for one that exists but is unpublished (404 = never
  // existed). Verified 2026-08-30 by cross-checking all 16 403s against the
  // tenant's own POST .../{site}/jobs search — every one absent, while live
  // controls returned 200. 403 is a NON-verdict everywhere else in the sweep
  // (bot blocks), hence the explicit per-probe opt-in below.
  if (/\.myworkdayjobs\.com$/.test(host) &&
      (m = path.match(/^\/(?:[a-z]{2}-[A-Z]{2}\/)?([^/]+)(\/job\/.+?)\/?$/))) {
    const tenant = host.split(".")[0];
    return {
      url: `https://${host}/wday/cxs/${tenant}/${m[1]}${m[2]}`,
      headers: { Accept: "application/json" },
      deadStatuses: [403],
    };
  }

  return null;
}

/** Final-URL landings that mean "this posting is gone", per platform. Each one
 *  is a redirect the platform performs INSTEAD of 404ing. Kept host-scoped so a
 *  legitimate url migration elsewhere in the bucket can't match: AI-scraped rows
 *  routinely redirect and stay alive (test-it.com gains a /hu/ prefix,
 *  sprinteins gains a -full-or-part-time suffix, keler PDFs move to a CDN). */
const DEAD_LANDINGS = [
  // karrierportal.hu tenants: bkk/groupama/uniqa/mvm/giro on *.karrierportal.hu,
  // and Magyar Posta on its own vanity host, same product.
  { host: /(^|\.)karrierportal\.hu$/, path: /^\/lejart-allashirdetes\/?$/i },
  { host: /^karrier\.posta\.hu$/, path: /^\/lejart-allashirdetes\/?$/i },
  // alfa.hu (2026-09-08): same product/path as the karrierportal.hu tenants
  // above, just on its own vanity host — confirmed live (karrier.alfa.hu
  // redirects a closed posting to this exact path).
  { host: /^karrier\.alfa\.hu$/, path: /^\/lejart-allashirdetes\/?$/i },
  { host: /(^|\.)kuka\.com$/, path: /\/company\/careers\/vacancies\/?$/i },
  { host: /(^|\.)accenture\.com$/, path: /\/careers\/jobsearch\/?$/i },
  { host: /(^|\.)bamboohr\.com$/, path: /^\/careers\/?$/i },
  { host: /(^|\.)zenitech\.co\.uk$/, path: /^\/careers\/life-at-zenitech\/?$/i },
  // sagemcom.com / bca.hu (2026-09-08): each confirmed live on a single closed
  // posting — a closed job's own link 302s to the tenant's generic careers
  // home instead of 404ing, same shape as kuka/accenture above.
  { host: /(^|\.)sagemcom\.com$/, path: /^\/accueil\.aspx$/i },
  { host: /(^|\.)bca\.hu$/, path: /^\/career\/index\/?$/i },
];

/** Closed-posting banners, matched on the body with <script>/<style> stripped.
 *  The stripping is load-bearing, not tidiness: SuccessFactors ships the
 *  "position has been filled" string in every page's i18n dictionary, so an
 *  unstripped match kills live jobs (jobs.bt.com was the observed trap). */
const DEAD_PHRASES = [
  "sorry, this position has been filled", // SuccessFactors: ALDI, atj.graphisoft.com
  "this position is no longer available", // thyssenkrupp
  "this position is no longer active", // sonrisa (Teamtailor)
  "this job has expired", // SmartRecruiters html (the API rule already covers it)
  // swicon (2026-09-08): the stored url is swicon-jobs.com, which now 30x's to
  // a swicon.com page bearing this exact banner — the redirect chain already
  // lands us on that final body, so no host-scoping is needed.
  "this job offer is no longer available",
];

function stripScripts(body) {
  return body.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");
}

function pathOf(u) {
  try { return new URL(u).pathname.replace(/\/+$/, "") || "/"; } catch { return null; }
}

/**
 * @param {{url:string, source:string}} row
 * @param {string} body   response body — from the API url when aiScrapedProbe
 *                        returned one, otherwise the posting's own page
 * @param {{status:number, finalUrl:string|null}} [res]
 * @returns {boolean} true only for a positive death verdict
 */
export function aiScrapedIsDead(row, body, res) {
  let u;
  try { u = new URL(row.url); } catch { return false; }
  const host = u.hostname.replace(/^www\./, "");

  // Rows the probe redirected to an API: `body` is that API's JSON, NOT a
  // rendered posting page, so none of the page-shaped rules below may look at
  // it — a job description that happens to quote one of the DEAD_PHRASES, or a
  // finalUrl that is simply the API url, would otherwise read as a death.
  // Greenhouse / Lever / Workday are decided by status code alone (404, plus
  // Workday's opted-in 403); SmartRecruiters and Eightfold are the ones that
  // need their body.
  if (aiScrapedProbe(row)) {
    if (EIGHTFOLD_HOSTS.has(host)) {
      const id = eightfoldJobId(u.pathname);
      // Truncated/unparseable sitemap body -> no verdict, not a death.
      return !!id && typeof body === "string" && body.includes("<urlset") && !body.includes(id);
    }
    if (host !== "jobs.smartrecruiters.com") return false;
    let j;
    try { j = JSON.parse(body); } catch { return false; } // truncated/HTML -> no verdict
    return !!j && j.active === false;
  }

  // --- Ashby: no per-job API. A removed posting keeps answering 200 but the
  // SPA collapses to a generic ~7.3 KB shell titled exactly "Jobs" that never
  // mentions the job id; a live one is 25-50 KB, titled "<role> @ <company>",
  // and embeds its own uuid. Both signals are required, so a redesign of the
  // shell (or a truncated body) fails open instead of emptying the bucket.
  if (host === "jobs.ashbyhq.com") {
    const id = (u.pathname.match(/([0-9a-f-]{30,})/i) || [])[1];
    if (!id || typeof body !== "string") return false;
    const title = (body.match(/<title[^>]*>([\s\S]{0,200}?)<\/title>/i) || [])[1];
    return title !== undefined && title.trim() === "Jobs" && !body.includes(id);
  }

  // --- Workable (2026-09-08): a removed posting's own /j/{code} link 30x's to
  // the account's board root with a `not_found=true` marker — confirmed live
  // on two different accounts (mpsolutions, spate). Not expressible as a
  // DEAD_LANDINGS path rule since the signal is a query param, not a path,
  // and the account segment varies. A live redirect (account rename) keeps
  // the /j/{code} suffix instead, so this can't false-positive on that case.
  if (host === "apply.workable.com" && res && res.finalUrl && /[?&]not_found=true(?:&|$)/.test(res.finalUrl)) {
    return true;
  }

  // --- cigpannonia.hu (2026-09-08): the site's job pages soft-404 — HTTP 200,
  // but the body IS the site's own 404 template, only visible via <title>
  // (confirmed live). Closes the gap this file's header used to list as
  // uncovered.
  if (host === "cigpannonia.hu" && typeof body === "string") {
    const title = (body.match(/<title[^>]*>([\s\S]{0,200}?)<\/title>/i) || [])[1] || "";
    if (title.trim().startsWith("404")) return true;
  }

  // --- redirect-to-careers-root landings
  if (res && res.status >= 200 && res.status < 400 && res.finalUrl) {
    const from = pathOf(row.url);
    const to = pathOf(res.finalUrl);
    let finalHost = null;
    try { finalHost = new URL(res.finalUrl).hostname.replace(/^www\./, ""); } catch { finalHost = null; }
    if (from !== null && to !== null && from !== to && finalHost) {
      for (const rule of DEAD_LANDINGS) {
        if (rule.host.test(finalHost) && rule.path.test(to)) return true;
      }
      // bankmonitor.hu (2026-09-09): unlike the DEAD_LANDINGS hosts above, a
      // closed posting here doesn't land on one fixed path — it 301s to a
      // DIFFERENT specific /karrier/{slug}/ posting (their own redirect
      // mapping, confirmed live: a never-existed slug plain-404s instead, so
      // this is a deliberate redirect, not generic not-found handling). Only
      // a same-site jump between two distinct /karrier/ posting paths counts;
      // this can't fire on a trailing-slash or query-only change (`from` and
      // `to` are already slash-normalized above) or on a genuine slug rename
      // that this site would instead serve as the same content.
      if (finalHost === "bankmonitor.hu" && /^\/karrier\/[^/]+$/.test(from) && /^\/karrier\/[^/]+$/.test(to)) {
        return true;
      }
    }
    // Greenhouse bounces a removed posting to the board with ?error=true.
    if (finalHost && /(^|\.)greenhouse\.io$/.test(finalHost) && /[?&]error=true/.test(res.finalUrl)) {
      return true;
    }
  }

  // --- closed-posting banners on the posting's own page
  if (typeof body === "string" && body) {
    const clean = stripScripts(body).toLowerCase();
    if (DEAD_PHRASES.some((p) => clean.includes(p))) return true;
  }

  return false;
}
