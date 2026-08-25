/*
  Hays Hungary – Budapest jobs scraper

  hays.hu is an Angular Universal (SSR) site: the FIRST batch (10 postings) of
  a listing renders in the plain HTML, but everything beyond that loads via
  client-side infinite scroll calling an HMAC-signed API
  (mapi.hays.com/jobportalapi/.../jobsv2) that a plain fetch can never
  authenticate. A real browser's own JS signs those requests correctly, so
  this scraper drives a headless Chromium (Playwright) and — instead of
  scraping the rendered DOM cards — INTERCEPTS the browser's own `jobsv2`
  network responses and reads the clean structured JSON straight out of them.
  That JSON already carries title/location/description/summary/responsibilities
  per job, so no separate per-job detail-page fetch is needed either (unlike
  every other scraper in this codebase, which must fetch each job's own page
  for experience/technologies). This is the first browser-driven AND the
  first network-interception-based source here.

  We deliberately do NOT filter by Hays' own "IT" specialism at scrape time:
  live-checked 2026-07-17, that facet currently returns 0 Budapest results,
  yet the full Budapest listing plainly contains IT-relevant postings ("IT
  Monitoring Specialist", "Service Desk Agent with Dutch", ...) that Hays
  itself just hasn't tagged that way (its own `xIndustryId` custom field is
  inconsistent — e.g. a "French-speaking Catalogue Specialist" business-services
  role is tagged xIndustryId="IT"). So we scrape the FULL Budapest listing and
  let this app's own title-keyword category classifier (same as every other
  source) surface the IT-relevant rows — see [[category-classification-audit]].

  Flow:
    1. Launch headless Chromium, open the Budapest listing (no specialism
       filter), accept the TrustArc cookie banner (required — the page can't
       be interacted with otherwise).
    2. Scroll-to-bottom repeatedly; each scroll makes the Angular app call
       .../jobsv2 for the next batch. A `response` listener parses each call's
       JSON and accumulates `result.jobs` (deduped by the GCJ resource `name`)
       until the collected count reaches the API's own authoritative
       `resultCount`, two scrolls in a row add nothing new, or a safety cap
       is hit.
    3. Keep only jobs whose own `location`/`locations` field contains
       "budapest" — the search's `location=` param is NOT a hard filter
       (live-checked: it also returns Győr/Kaposvár/Tatabánya/... jobs), same
       gotcha as [[profession-location-gotchas]].
    4. Senior-title filter (loadFilters), url-keyed upsert (source = "Hays").
       experience/technologies come from the job's own description/summary/
       responsibilities text already in the API payload — reuses the shared
       extractBodyExperience/extractTechnologies (they accept any HTML
       fragment, not just a full fetched page).
    5. Budapest listing is a full re-enumeration every run once fully
       collected, so reconcileActive runs with complete:true (can deactivate).

  NOT on any schedule yet — first runs must be triggered by hand
  (Authorization: Bearer $CRON_SECRET) and checked in the UI before wiring
  into cron_dispatcher_daily.mjs, same caution as cron_jobs_AI-background.mjs.
*/

import { Pool } from "pg";
import { chromium as playwrightCore } from "playwright-core";
import { loadFilters } from "./load_filters.mjs";
import { logFetchError, withTimeout } from "./_error-logger.mjs";
import { reconcileActive } from "./_active_core.mjs";
import {
  isInternshipTitle,
  isJuniorTitle,
  isMidLevelTitle,
  extractBodyExperience,
  extractTechnologies,
  isSeniorExperience,
} from "./_experience_core.mjs";
import { shouldSkipTitleFilter, shouldSkipSeniorExperience, seniorAwareExperience } from "./_seniority_policy.mjs";

const SOURCE = "Hays";
const COMPANY = "Hays Hungary Kft.";
const LIST_URL =
  "https://www.hays.hu/allas-kereses?q=&location=Budapest,%20Hungary&specialismId=&subSpecialismId=&locationf=&industryf=&sortType=0&jobType=-1&flexiWorkType=-1&payTypefacet=-1&minPay=0&maxPay=11&jobSource=HaysGCJ";
const CONSENT_TEXT = "Elfogadás és továbblépés";
const JOBSV2_PATTERN = /jobsv2/i;
const MAX_SCROLLS = 40; // ~400 jobs headroom over the ~145 currently live
const STABLE_ROUNDS_NEEDED = 2;

let _filters = [];

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

/* ── text/url helpers ────────────────────────────────────────────── */

function normalizeWhitespace(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

function normalizeText(s) {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function _blacklistRegex(k) {
  const escaped = normalizeText(k).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i");
}

function isSeniorLike(title) {
  return shouldSkipTitleFilter(title, _filters);
}

// jobsv2 gives us a ready-to-use navigable URL in two shapes: the SEO slug
// (nonFilterableCustomFields.xLocaleRecordID, e.g. .../french-speaking-
// catalogue-specialist-budapest_1192245) or the bare trackingUrl/
// jobRequisitionId (.../pozicio-leiras/JOB_5317356). Prefer the slug (matches
// what a real visitor lands on); either is stable and directly navigable, no
// query string to strip.
function jobUrl(job) {
  const slug = job?.nonFilterableCustomFields?.xLocaleRecordID?.values?.[0];
  const raw = slug || job?.trackingUrl || job?.jobRequisitionId;
  if (!raw) return null;
  try {
    const u = new URL(raw);
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

function jobLocationText(job) {
  return [job?.location, ...(Array.isArray(job?.locations) ? job.locations : [])]
    .filter(Boolean)
    .join(" ");
}

// description/summary/responsibilities/qualifications are HTML fragments
// (e.g. "...Budapest, is looking for a<br>French-Speaking..."), not full
// pages — cheerio.load() still wraps a fragment in a virtual body, so the
// shared extractBodyExperience/extractTechnologies (which both just read
// $("body")) work unmodified on this joined fragment.
function jobDescriptionHtml(job) {
  return [job?.description, job?.summary, job?.responsibilities, job?.qualifications]
    .filter(Boolean)
    .join(" ");
}

/* ── browser ──────────────────────────────────────────────────────── */

// Netlify Functions run on AWS Lambda in production (AWS_LAMBDA_FUNCTION_NAME
// is set there) — use the Lambda-sized @sparticuz/chromium binary with
// playwright-core. Locally (netlify dev / manual node run) that binary is a
// Linux build and won't launch, so fall back to the full "playwright"
// package's own downloaded browser for local testing.
async function launchBrowser() {
  if (process.env.AWS_LAMBDA_FUNCTION_NAME) {
    const { default: chromium } = await import("@sparticuz/chromium");
    return playwrightCore.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: true,
    });
  }
  const { chromium: localChromium } = await import("playwright");
  return localChromium.launch({ headless: true });
}

async function acceptConsent(page) {
  try {
    const btn = page.getByText(CONSENT_TEXT, { exact: false }).first();
    await btn.click({ timeout: 8000 });
  } catch {
    // Banner not shown (or already accepted) — safe to continue either way.
  }
}

/**
 * Scroll-trigger the Budapest listing's jobsv2 calls and collect every
 * distinct job from the intercepted JSON responses.
 * @returns {{ jobs: Map<string, object>, complete: boolean }}
 */
async function scrapeListing(page) {
  const jobs = new Map(); // keyed by the GCJ resource `name` (unique per job)
  let resultCount = null;

  page.on("response", async (res) => {
    if (!JOBSV2_PATTERN.test(res.url())) return;
    try {
      const body = await res.json();
      const result = body?.data?.result;
      if (!result) return;
      if (typeof result.resultCount === "number") {
        resultCount = Math.max(resultCount ?? 0, result.resultCount);
      }
      for (const job of result.jobs || []) {
        if (job?.name) jobs.set(job.name, job);
      }
    } catch {
      // Non-JSON or unexpected shape — ignore, next call may succeed.
    }
  });

  await page.goto(LIST_URL, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(5000);
  await acceptConsent(page);
  await page.waitForTimeout(3000);

  let prevCount = -1;
  let stableRounds = 0;
  let complete = false;

  for (let i = 0; i < MAX_SCROLLS; i++) {
    if (resultCount != null && jobs.size >= resultCount) {
      complete = true;
      break;
    }
    if (jobs.size === prevCount) {
      stableRounds++;
      if (stableRounds >= STABLE_ROUNDS_NEEDED) {
        complete = true;
        break;
      }
    } else {
      stableRounds = 0;
    }
    prevCount = jobs.size;
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(2000);
  }

  return { jobs, complete };
}

/* ── db ──────────────────────────────────────────────────────────── */

// Returns true if this url was newly inserted (false = already existed).
async function upsertJob(client, item) {
  const res = await client.query(
    `INSERT INTO job_posts (source, title, url, company, experience, technologies, first_seen)
     VALUES ($1,$2,$3,$4,$5,$6,NOW())
     ON CONFLICT (source, url) DO NOTHING
     RETURNING id`,
    [SOURCE, item.title, item.url, COMPANY, seniorAwareExperience(item.title, item.experience), item.technologies ?? null]
  );
  return res.rowCount > 0;
}

/* ── handler ──────────────────────────────────────────────────────── */

const _runJob = withTimeout("cron_jobs_HAYS-background", async () => {
  _filters = await loadFilters();
  const client = await pool.connect();

  let browser;
  let rawJobs = [];
  let listingComplete = false;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    const { jobs, complete } = await scrapeListing(page);
    rawJobs = [...jobs.values()];
    listingComplete = complete;
  } catch (err) {
    await logFetchError("cron_jobs_HAYS-background", { url: LIST_URL, message: err.message });
    console.error(`[Hays] listing scrape failed: ${err.message}`);
    client.release();
    return;
  } finally {
    await browser?.close().catch(() => {});
  }

  console.log(`[Hays] intercepted ${rawJobs.length} jobs, listingComplete=${listingComplete}`);

  const foundUrls = [];
  let newCount = 0;
  let existedCount = 0;
  let skippedSenior = 0;
  let skippedNonBudapest = 0;
  const seen = new Set();

  try {
    for (const job of rawJobs) {
      const title = normalizeWhitespace(job.title);
      const url = jobUrl(job);
      if (!title || !url || seen.has(url)) continue;
      seen.add(url);

      if (!normalizeText(jobLocationText(job)).includes("budapest")) {
        skippedNonBudapest++;
        continue;
      }

      // Counted toward foundUrls even if senior-filtered below: the posting
      // genuinely exists on the site, so a filter-word change must never be
      // able to deactivate an otherwise-live row.
      foundUrls.push(url);

      if (shouldSkipTitleFilter(title, _filters)) {
        skippedSenior++;
        continue;
      }

      const descHtml = jobDescriptionHtml(job);
      let experience = isInternshipTitle(title)
        ? "diákmunka"
        : isJuniorTitle(title)
        ? "junior"
        : isMidLevelTitle(title)
        ? "medior"
        : extractBodyExperience(descHtml) || "-";
      const technologies = extractTechnologies(descHtml);

      if (shouldSkipSeniorExperience(isSeniorExperience(experience))) {
        skippedSenior++;
        continue;
      }

      const wasNew = await upsertJob(client, { title, url, experience, technologies });
      if (wasNew) newCount++;
      else existedCount++;
    }

    console.log(
      `[Hays] DONE — jobs=${rawJobs.length}, new=${newCount}, existed=${existedCount}, ` +
      `skip_senior=${skippedSenior}, skip_non_budapest=${skippedNonBudapest}, complete=${listingComplete}`
    );

    const rc = await reconcileActive(client, SOURCE, foundUrls, { complete: listingComplete });
    console.log(`[Hays] active reconcile — ${JSON.stringify(rc)}`);
  } finally {
    client.release();
  }

  return new Response("OK");
});

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  const expected = process.env.CRON_SECRET;
  if (!expected || token !== expected) {
    return new Response("Unauthorized", { status: 401 });
  }
  return _runJob(request);
};
