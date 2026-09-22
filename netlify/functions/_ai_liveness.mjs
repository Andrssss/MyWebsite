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
// 2026-09-15: user pushed back on a manual sweep finding only 2 dead out of 522
// active ai-scraped+ats-crawl rows ("lehetetlen" — too few). A review pass
// scoped to hosts NOT covered by any rule below (title-word-hit fraction
// against the fetched body, same method as 08-30/09-02) turned up two real
// gaps, both now fixed: (1) karrier.fundamenta.hu and karrier.kh.hu redirect a
// closed posting to `/lejart-allashirdetes`, the exact same white-label ATS
// signature as the karrierportal.hu/posta/alfa tenants above — generalized to
// a host-agnostic path check (LEJART_ALLASHIRDETES_PATH) instead of enumerating
// a 4th and 5th tenant one at a time; (2) telekom.hu's `/karrier/api/jobs`
// board-listing check (documented as a working method back on 08-30 but never
// actually wired into these functions) is now a real SWEEP_PROBE_OVERRIDES
// entry. Everything else the review pass flagged (36 of 57 candidates) turned
// out to be non-verdicts on re-check from a different vantage point — timeouts/
// connection resets/403s that resolved fine from elsewhere (proves the sweep's
// own "never trust a negative status" rule earns its keep), PDF postings and
// client-rendered SPA shells (bamboohr, eightfold tenants outside
// EIGHTFOLD_HOSTS, hrmaster.hu, indivizo, netopgraf) where 0% title-hit is
// expected on a live page too, and one site (be-novative.com) with a merely
// EXPIRED TLS cert whose content was confirmed live anyway — none of these are
// new rule candidates, they're the same fail-open-on-purpose list as before.
//
// 2026-09-15, later same day: a user-reported batch of 8 false-active rows
// (found by hand, not by any sweep) surfaced three more real gaps, each
// cross-checked against a live control before being added, same rule as
// every entry above:
// - naih.hu: postings are bare PDF files (no status of their own — a closed
//   one keeps answering 200 forever, per the PDF caveat in the 2026-09-15
//   entry below). The site's own /allaspalyazat listing page links every
//   CURRENTLY open posting's PDF by filename; the reported closed posting's
//   filename is confirmed absent from it while the listing's one live PDF is
//   confirmed present, so this is a listing-membership check, same shape as
//   the Eightfold sitemap / telekom.hu API checks above.
// - lechnerkozpont.hu: a removed posting's own page answers 403 where a live
//   one answers 200 — confirmed on 3 reported-dead vs 4 currently-listed-live
//   postings, stable across 3 repeated rounds each (ruling out a rate-limit
//   fluke). Opted into deadStatuses, same narrow shape as Workday's CXS 403.
// - trskarrier.hu: every posting's page embeds a client-side JS countdown to
//   its OWN deadline as a literal Date string; the "jelentkezési határidő
//   lejárt" text the countdown swaps in on expiry is baked into every
//   posting's script regardless of actual state (same i18n-template trap
//   DEAD_PHRASES' script-stripping already guards against), so the *date* is
//   parsed out and compared to now instead of matching that string.
// The other 5 of the 8 reported rows (Qube/Greenhouse, 2×NISZ) were already
// correctly classified dead by the existing Greenhouse-API and plain-404
// rules — they just hadn't been swept yet — so no rule change was needed for
// those; the scoped re-sweep after this deploy is what actually clears them.
//
// 2026-09-22: a full active+inactive audit of both sources (514 active + 103
// revive-eligible inactive rows) found 0 wrong labels under the rules as they
// stood at the time, plus 3 real gaps via the fallback title-hit review (17
// candidates total), each confirmed live before fixing:
// - UserWise Services was stored as userwise-services.workable.com/jobs/{id}
//   (a company-branded subdomain, not apply.workable.com) and its own
//   redirect chain already landed on the documented not_found=true marker —
//   but the Workable rule below required the STORED row's host to literally
//   be apply.workable.com, so it never even asked the question. Widened to
//   any *.workable.com host (see that rule's own comment).
// - morganstanley.eightfold.ai wasn't in EIGHTFOLD_HOSTS; its sitemap is
//   confirmed unpaginated and the flagged job id is absent from it. Added.
// - fizetesipont.hrfelho.hu (OFSZ Zrt.) renders a plain-HTML Hungarian
//   closed-posting banner ("...aktualitását vesztette...") before a
//   client-side redirect — confirmed present on the dead posting and absent
//   on a currently-listed live one on the same tenant. Added to DEAD_PHRASES.
// The rest of the 17 candidates were the same already-known fail-open-on-
// purpose shape, each re-confirmed live this pass rather than just assumed:
// PDF postings (keler.hu/netclass.eu/tarhely.eu — all 7 flagged PDFs are
// still linked from their own site's current careers-listing page, so
// genuinely live, just unmatchable by a text heuristic), client-rendered SPA
// shells with no server-side content (netopgraf.hu, indivizo, bamboohr), and
// two low-hit-fraction rows (personio.de, smartcharging.hu) whose fetched
// pages carry a proper job-specific <title> and no closed banner —
// paraphrased-title false positives of the heuristic, not deaths.
//
// Same day, follow-up: the user manually confirmed the 2 hrmaster.hu rows
// above (magicom/segelyszervezet) were genuinely dead, then asked for the
// "not found" banner itself to be wired in — which meant re-testing the
// 2026-09-09 "no plain-HTTP signal exists here at all" conclusion, since that
// banner IS plain HTML. That conclusion turned out to be an artifact of only
// ever testing already-dead tenants against each other: a fresh check found
// an independent, genuinely live hrmaster.hu posting (a different company
// entirely) that renders full server-side job content with zero occurrences
// of the banner, while multiple independently-found closed postings all
// render it — real signal, not a universal client-rendered shell. Added to
// DEAD_PHRASES (see that entry for the HTML-entity-encoding gotcha).
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
// morganstanley.eightfold.ai added 2026-09-22: confirmed live (curl) —
// /careers/sitemap.xml is a flat <urlset> (no <sitemapindex>) with 1317
// entries, and the audit's flagged job id (549795197984) is absent from it
// while the source page itself carried the platform's generic "Jobs" shell.
const EIGHTFOLD_HOSTS = new Set(["jobs.ericsson.com", "jobs.vodafone.com", "morganstanley.eightfold.ai"]);

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

  // telekom.hu — /karrier/jobs?jobId=… is a client-rendered SPA with no
  // per-job status of its own; the tenant's own board API lists every
  // currently open job by id (aiScrapedIsDead below checks membership, same
  // shape as the Eightfold sitemap check above). Confirmed live 2026-09-15.
  if (host === "telekom.hu" && path === "/karrier/jobs" && u.searchParams.get("jobId")) {
    return { url: "https://www.telekom.hu/karrier/api/jobs", headers: { Accept: "application/json" } };
  }

  // naih.hu (2026-09-15): postings are plain PDF files with no status of
  // their own — a closed one keeps answering 200 forever (a government site,
  // old announcement PDFs are simply left in place). The site's own
  // /allaspalyazat listing page links every CURRENTLY open posting's PDF by
  // filename; confirmed live that a user-reported closed posting (deadline
  // 2026-07-31) is entirely absent from it while the one PDF the listing
  // currently does link is present verbatim (aiScrapedIsDead below checks
  // the row's own filename for membership, same shape as the telekom.hu id
  // check above).
  if (host === "naih.hu" && /^\/files\/[^/]+\.pdf$/i.test(path)) {
    return { url: "https://www.naih.hu/allaspalyazat" };
  }

  // lechnerkozpont.hu (2026-09-15): a removed posting's own page answers 403
  // where a live one answers 200 — confirmed live on 3 user-reported-closed
  // postings vs the 4 postings currently listed on the tenant's own
  // /oldal/karrier page, stable across 3 repeated rounds each (not a
  // rate-limit/bot-block fluke, unlike the general 403-is-a-non-verdict
  // assumption elsewhere in the sweep). Same narrow opt-in shape as Workday's
  // CXS 403 above.
  if (host === "lechnerkozpont.hu" && /^\/karrier\/\d+-/.test(path)) {
    return { url: row.url, deadStatuses: [403] };
  }

  return null;
}

/** Final-URL landings that mean "this posting is gone", per platform. Each one
 *  is a redirect the platform performs INSTEAD of 404ing. Kept host-scoped so a
 *  legitimate url migration elsewhere in the bucket can't match: AI-scraped rows
 *  routinely redirect and stay alive (test-it.com gains a /hu/ prefix,
 *  sprinteins gains a -full-or-part-time suffix, keler PDFs move to a CDN). */
// Shared white-label ATS vendor signature: whatever the tenant's own vanity
// host is, a closed posting on this product 30x's to exactly this path
// ("lejárt álláshirdetés" = "expired job posting"). Confirmed independently on
// FIVE unrelated tenants now — karrierportal.hu (multi-tenant: bkk/groupama/
// uniqa/mvm/giro), karrier.posta.hu, karrier.alfa.hu (2026-09-08), and
// karrier.fundamenta.hu / karrier.kh.hu (2026-09-15, found via a title-word-hit
// review pass after these two sat active past closing with 0% title match on
// this exact landing page). The path string is distinctive enough that
// host-scoping buys no real safety, only the enumerate-every-new-tenant staleness
// this repo has hit before (see hardcoded-taxonomy-id-lists-go-stale) — so unlike
// every other entry in DEAD_LANDINGS below, this one is checked for ANY host.
const LEJART_ALLASHIRDETES_PATH = /^\/lejart-allashirdetes\/?$/i;

const DEAD_LANDINGS = [
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
  // hrfelho.hu (2026-09-22): a white-label HR platform vendor (its own privacy
  // text names it as the operator behind at least one client's career portal,
  // fizetesipont.hrfelho.hu/OFSZ Zrt. — same shape as the karrierportal.hu
  // family, so left host-unscoped for the same staleness reason). A closed
  // posting's own url renders this exact server-side banner (confirmed
  // present in the plain HTML, NOT inside the page's <script> redirect timer)
  // before JS redirects the visitor to the current listing; confirmed absent
  // on a currently-listed live posting on the same tenant.
  "aktualitását vesztette",
  // hrmaster.hu (2026-09-22): CORRECTS the 2026-09-09 entry above, which
  // concluded "no plain-HTTP signal exists here at all" after testing only
  // magicom/segelyszervezet against real/fake/wrong-slug ids on those SAME
  // (already-dead) tenants — every id looked byte-identical because all of
  // them WERE dead, not because the platform can't be read without JS. A
  // fresh check across independent tenants proves otherwise: a genuinely live
  // posting (btesz.hrmaster.hu/.../5/gondozoapolo) renders full server-side
  // job content with zero occurrences of this phrase, while every confirmed-
  // closed posting checked (magicom/segelyszervezet, both user-confirmed
  // dead, plus two more tenants found independently closed) renders this
  // exact banner instead. The platform encodes accented characters as HTML
  // numeric entities rather than raw UTF-8 (unlike hrfelho.hu above), so the
  // phrase below is written in that literal encoded form — matching it after
  // decoding would miss it entirely.
  "a keresett &#225;ll&#225;shirdet&#233;s nem tal&#225;lhat&#243;",
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
    if (host === "telekom.hu") {
      const jobId = u.searchParams.get("jobId");
      let j;
      try { j = JSON.parse(body); } catch { return false; } // truncated/HTML -> no verdict
      const list = Array.isArray(j?.jobList) ? j.jobList : null;
      // Missing/unparseable list -> no verdict, not a death (fail open).
      return !!jobId && !!list && !list.some((job) => job && job.id === jobId);
    }
    if (host === "naih.hu") {
      const filename = (u.pathname.match(/\/files\/([^/]+\.pdf)$/i) || [])[1];
      // Missing filename or an unparseable/truncated listing page -> no
      // verdict, not a death (fail open) — same shape as the other
      // membership checks above.
      if (!filename || typeof body !== "string") return false;
      return !body.includes(filename);
    }
    // lechnerkozpont.hu's death question is answered entirely by its
    // deadStatuses opt-in above (403 on the row's own page) — this branch is
    // only reached on a non-403 response, i.e. a live posting, so no body
    // rule belongs here.
    if (host === "lechnerkozpont.hu") return false;
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
  // 2026-09-22: widened from a literal `host === "apply.workable.com"` check —
  // a full activity-label audit found a row stored under a company-branded
  // subdomain (userwise-services.workable.com/jobs/{id}, not apply.workable.com)
  // whose redirect chain landed on the exact same apply.workable.com/{account}/
  // ?not_found=true marker, but the old host check only matched the STORED
  // row's own host, never the redirect target, so it silently never fired for
  // any account-subdomain-stored posting. The verdict lives entirely in
  // `res.finalUrl` (an unambiguous platform-owned marker), so matching any
  // *.workable.com origin host is safe — it just widens which stored rows are
  // even allowed to ask the question, not what counts as an answer.
  if (/(^|\.)workable\.com$/.test(host) && res && res.finalUrl && /[?&]not_found=true(?:&|$)/.test(res.finalUrl)) {
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

  // --- trskarrier.hu (2026-09-15): every posting embeds a client-side
  // countdown to its OWN deadline as a raw JS Date literal
  // (`var countDownDate = new Date("Dec 31, 2025 22:00:00")`), and the same
  // script's "A jelentkezési határidő lejárt!" string sits in the page
  // source of EVERY posting regardless of whether it's actually expired (the
  // countdown only swaps the DOM text client-side once distance<0) — the
  // exact i18n-template trap DEAD_PHRASES' script-stripping already guards
  // against, so that string can't be matched directly. The date itself is
  // real per-posting content, though: parse it and compare to now.
  if (host === "trskarrier.hu" && typeof body === "string") {
    const m = body.match(/var\s+countDownDate\s*=\s*new Date\("([^"]+)"\)/);
    if (m) {
      const deadline = Date.parse(m[1]);
      if (!Number.isNaN(deadline) && deadline < Date.now()) return true;
    }
  }

  // --- redirect-to-careers-root landings
  if (res && res.status >= 200 && res.status < 400 && res.finalUrl) {
    const from = pathOf(row.url);
    const to = pathOf(res.finalUrl);
    let finalHost = null;
    try { finalHost = new URL(res.finalUrl).hostname.replace(/^www\./, ""); } catch { finalHost = null; }
    if (from !== null && to !== null && from !== to && finalHost) {
      if (LEJART_ALLASHIRDETES_PATH.test(to)) return true;
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
