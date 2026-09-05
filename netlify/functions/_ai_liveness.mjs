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
//     4  one-offs         (join.com repost, listing-only, soft-404) — NOT covered here
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

/** Hosts whose posting-death question is answered by the platform's own API.
 *  Returns a SWEEP_PROBE_OVERRIDES descriptor, or null to ask the row's own url. */
export function aiScrapedProbe(row) {
  let u;
  try { u = new URL(row.url); } catch { return null; }
  const host = u.hostname.replace(/^www\./, "");
  const path = u.pathname;
  let m;

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

  // Recruitee — <slug>.recruitee.com/o/<job-slug>. ats-crawl always stores the
  // canonical `<slug>.recruitee.com` form, never a company's custom domain
  // (see _ats_providers.mjs's recruitee header), so the tenant is always the
  // host's own first label.
  //
  // 2026-09-05 (3 user-reported "still shows active" postings — MailerLite,
  // TransPerfect, ScholarshipOwl): only one was confirmed genuinely gone — a
  // renamed MailerLite posting whose OLD slug 404s outright (already caught by
  // the sweep's plain-404 rule with no change needed here); the other two
  // turned out to still be published, live checks against the tenant's own
  // /api/offers/ feed. So this probe is precautionary, not a confirmed-bug fix:
  // Recruitee gives no *other* removal signal on the posting's own page (no
  // banner, no status field), so if a posting is ever unpublished WITHOUT its
  // url 404ing — the nofluffjobs/dreamjobs "evergreen SEO page" pattern, not
  // yet actually observed here — the plain-404 rule alone would miss it. This
  // asks the tenant's own offers feed (the exact endpoint _ats_providers.mjs
  // already reads to build the row) instead of trusting the posting page.
  if (host.endsWith(".recruitee.com") && (m = path.match(/^\/o\/([^/]+)\/?$/))) {
    return { url: `https://${host.split(".")[0]}.recruitee.com/api/offers/` };
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
  { host: /(^|\.)kuka\.com$/, path: /\/company\/careers\/vacancies\/?$/i },
  { host: /(^|\.)accenture\.com$/, path: /\/careers\/jobsearch\/?$/i },
  { host: /(^|\.)bamboohr\.com$/, path: /^\/careers\/?$/i },
  { host: /(^|\.)zenitech\.co\.uk$/, path: /^\/careers\/life-at-zenitech\/?$/i },
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
  // Workday's opted-in 403); SmartRecruiters and Recruitee are the ones that
  // need their body.
  if (aiScrapedProbe(row)) {
    if (host.endsWith(".recruitee.com")) {
      const slug = (u.pathname.match(/^\/o\/([^/]+)\/?$/) || [])[1];
      if (!slug) return false;
      let j;
      try { j = JSON.parse(body); } catch { return false; } // truncated/HTML -> no verdict
      const offers = Array.isArray(j?.offers) ? j.offers : [];
      const offer = offers.find((o) => o && o.slug === slug);
      // Absent entirely, or present with a non-published status (draft,
      // internal, archived, …) — mirrors the exact filter _ats_providers.mjs
      // uses to decide which offers are worth ingesting in the first place.
      if (!offer) return true;
      return !(!offer.status || offer.status === "published");
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
