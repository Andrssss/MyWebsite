/*
  Startup Jobs (startup.jobs) — Hungary / Engineering scraper

  API: GET https://api.startup.jobs/v1/jobs?role=engineering&country=HU
       Official, free, documented REST API (OpenAPI spec at
       api.startup.jobs/v1/openapi.json) — used instead of scraping
       startup.jobs/locations/hungary/engineering because that HTML listing
       page's own job count ("3 Jobs") did not match the ~20 job links it
       actually rendered, several from Belgium/China/etc — its location
       bucketing can't be trusted. The API's `location.country_code` on each
       job is the ground-truth field, so we ALSO re-check it per row (belt
       and suspenders) rather than trusting the query param alone.

  Auth: Bearer token in STARTUPJOBS_API_KEY (free account, created by the
        site owner at startup.jobs/account/api_keys — 20 req/min free tier).

  ⚠️ NOT a full-listing source — do not treat like most other scrapers here:
  the endpoint returns only jobs PUBLISHED in the last 14 days, newest first
  (per the OpenAPI description), not "every currently open Hungary/engineering
  job". A posting that stays open past 14 days simply stops appearing in this
  feed even though it's still live on startup.jobs. Reconciling with
  complete:true would therefore deactivate genuinely-open postings once they
  age out of the window — the same failure mode this codebase already hit
  with `talent`'s rotating search results (see _active_core.mjs). So this
  scraper ALWAYS reconciles reactivate-only (complete:false); "startupjobs" is
  registered in SWEEP_SOLE_DEACTIVATOR_SOURCES so the cross-source 404 sweep
  (cron_404sweep-background.mjs) is its sole deactivator, via the sweep's
  default plain-404 rule. That default is UNVERIFIED for this source (no
  confirmed-dead posting observed yet to check whether a closed job page 404s
  vs. shows a banner) — if rows are ever seen stuck active long after actually
  closing, check a known-dead startup.jobs posting and add a BANNER_DEAD_SOURCES
  / REDIRECT_DEAD_SOURCES entry the same way bluebird/nofluffjobs got theirs.

  Company field is directly on the job (company.name) — no A_K/schönherz-style
  anonymous-client gap here. Senior gate is the same uniform title-denylist
  every other scraper uses (user decision 2026-07-20): nothing else drops a row.
*/

import { Pool } from "pg";
import https from "https";
import http from "http";
import zlib from "zlib";
import { loadFilters } from "./load_filters.mjs";
import { logFetchError, withTimeout } from "./_error-logger.mjs";
import { reconcileActive } from "./_active_core.mjs";
import { loadCrossSourceDupeIndex, isCrossSourceDupe } from "./_cross_source_dupe.mjs";
import {
  isInternshipTitle,
  isJuniorTitle,
  isMidLevelTitle,
  extractBodyExperience,
  extractTechnologies,
  isSeniorExperience,
} from "./_experience_core.mjs";
import { shouldSkipTitleFilter, shouldSkipSeniorExperience, seniorAwareExperience } from "./_seniority_policy.mjs";

let _filters = [];

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

const API_BASE = "https://api.startup.jobs/v1/jobs";
const ROLE = "engineering";
const COUNTRY = "HU";
const PAGE_LIMIT = 50;
const MAX_PAGES = 10; // real result set is tiny (<10); safety valve only

/* ── helpers ─────────────────────────────────────────────────── */

function normalizeText(s) {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeWhitespace(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

function normalizeUrl(raw) {
  try {
    const u = new URL(raw);
    u.hash = "";
    ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
     "fbclid", "gclid", "gad_source", "gclsrc", "gbraid"].forEach((p) => u.searchParams.delete(p));
    return u.toString().replace(/\?$/, "");
  } catch {
    return raw;
  }
}

function _blacklistRegex(k) {
  const escaped = normalizeText(k).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i");
}

// job_filters title denylist — same uniform senior gate every scraper uses.
function isSeniorLike(title) {
  return shouldSkipTitleFilter(title, _filters);
}

function titleExperience(title) {
  if (isInternshipTitle(title)) return "diákmunka";
  if (isJuniorTitle(title)) return "junior";
  if (isMidLevelTitle(title)) return "medior";
  return null;
}

/* ── fetch (gzip/deflate/br + redirect + bearer auth) ───────────── */

function getText(url, redirectLeft = 5) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;

    const req = lib.request(
      u,
      {
        method: "GET",
        headers: {
          "User-Agent": "JobWatcher/1.0",
          Accept: "application/json",
          "Accept-Encoding": "gzip,deflate,br",
          Authorization: `Bearer ${process.env.STARTUPJOBS_API_KEY}`,
        },
        timeout: 25000,
      },
      (res) => {
        const code = res.statusCode || 0;

        if ([301, 302, 303, 307, 308].includes(code)) {
          const loc = res.headers.location;
          if (!loc) return reject(new Error(`HTTP ${code} (no Location) for ${url}`));
          if (redirectLeft <= 0) return reject(new Error(`Too many redirects for ${url}`));
          res.resume();
          return resolve(getText(new URL(loc, url).toString(), redirectLeft - 1));
        }

        const enc = String(res.headers["content-encoding"] || "").toLowerCase();
        let stream = res;
        if (enc.includes("gzip")) stream = res.pipe(zlib.createGunzip());
        else if (enc.includes("deflate")) stream = res.pipe(zlib.createInflate());
        else if (enc.includes("br")) stream = res.pipe(zlib.createBrotliDecompress());

        let data = "";
        stream.setEncoding("utf8");
        stream.on("data", (c) => (data += c));
        stream.on("end", () =>
          code >= 200 && code < 300 ? resolve(data) : reject(new Error(`HTTP ${code} for ${url}: ${data.slice(0, 300)}`))
        );
        stream.on("error", reject);
      }
    );

    req.on("timeout", () => req.destroy(new Error(`Timeout for ${url}`)));
    req.on("error", reject);
    req.end();
  });
}

async function getJson(url) {
  return JSON.parse(await getText(url));
}

/* ── db ──────────────────────────────────────────────────────── */

async function upsertJob(client, source, item) {
  const res = await client.query(
    `INSERT INTO job_posts (source, title, url, experience, company, technologies, first_seen)
     VALUES ($1,$2,$3,$4,$5,$6,NOW())
     ON CONFLICT (source, url) DO NOTHING
     RETURNING id;`,
    [source, item.title, item.url, seniorAwareExperience(item.title, item.experience) ?? "-", item.company ?? null, item.technologies ?? null]
  );
  return res.rowCount > 0;
}

/* ── handler ─────────────────────────────────────────────────── */

const _runJob = withTimeout("cron_jobs_STARTUPJOBS-background", async () => {
  if (!process.env.STARTUPJOBS_API_KEY) {
    console.warn("[startupjobs] STARTUPJOBS_API_KEY not set — skipping run");
    return new Response("missing api key", { status: 200 });
  }

  _filters = await loadFilters();
  const client = await pool.connect();
  try {
    const foundUrls = [];
    let newlyInserted = 0;
    let alreadyExisted = 0;
    let skippedSenior = 0;
    let skippedWrongCountry = 0;
    let skippedNoData = 0;
    let skippedCrossSourceDupe = 0;
    let fetchFailed = false;

    // startup.jobs is an aggregator: the 2026-08-28 overlap analysis found 45
    // of its 56 rows were already on the board from the employer-side sources,
    // with no discovery-time advantage. Anything another source already carries
    // under the same <company first word>|<title> key is dropped before insert.
    const dupeIndex = await loadCrossSourceDupeIndex(client, "startupjobs");
    console.log(`[startupjobs] cross-source dupe index: ${dupeIndex.size} keys`);

    let cursor = null;
    let page = 0;

    do {
      page++;
      const qs = new URLSearchParams({ role: ROLE, country: COUNTRY, limit: String(PAGE_LIMIT) });
      if (cursor != null) qs.set("starting_after", String(cursor));
      const pageUrl = `${API_BASE}?${qs.toString()}`;

      let result;
      try {
        result = await getJson(pageUrl);
      } catch (err) {
        fetchFailed = true;
        await logFetchError("cron_jobs_STARTUPJOBS-background", { url: pageUrl, message: err.message });
        console.error(`[startupjobs] page ${page} fetch failed: ${err.message}`);
        break;
      }

      const jobs = Array.isArray(result?.data) ? result.data : [];
      console.log(`[startupjobs] page ${page}: ${jobs.length} jobs (total_count=${result?.total_count ?? "?"})`);

      for (const job of jobs) {
        try {
          const url = normalizeUrl(job?.url || "");
          const title = normalizeWhitespace(job?.title);
          if (!url || !title) {
            skippedNoData++;
            continue;
          }

          // Belt-and-suspenders: trust the job's OWN country_code over the
          // query filter (the equivalent HTML listing page proved unreliable).
          if (job?.location?.country_code && job.location.country_code !== COUNTRY) {
            skippedWrongCountry++;
            console.log(`[startupjobs] SKIP wrong-country (${job.location.country_code}) "${title}"`);
            continue;
          }

          if (shouldSkipTitleFilter(title, _filters)) {
            skippedSenior++;
            console.log(`[startupjobs] SKIP title-denylist "${title}" → ${url}`);
            continue;
          }

          const descriptionHtml = job?.description_html || "";
          const experience = titleExperience(title) ?? extractBodyExperience(descriptionHtml) ?? "-";
          const technologies = extractTechnologies(descriptionHtml);
          const company = normalizeWhitespace(job?.company?.name) || null;

          if (isCrossSourceDupe(dupeIndex, company, title)) {
            skippedCrossSourceDupe++;
            console.log(`[startupjobs] SKIP cross-source dupe "${title}" @ ${company} → ${url}`);
            continue;
          }

          if (shouldSkipSeniorExperience(isSeniorExperience(experience))) {
            skippedSenior++;
            console.log(`[startupjobs] SKIP senior-experience [${experience}] "${title}" → ${url}`);
            continue;
          }

          const wasNew = await upsertJob(client, "startupjobs", { title, url, experience, company, technologies });
          foundUrls.push(url);
          if (wasNew) {
            newlyInserted++;
            console.log(`[startupjobs] NEW "${title}" @ ${company ?? "-"} exp=${experience} → ${url}`);
          } else {
            alreadyExisted++;
          }
        } catch (err) {
          console.error(`[startupjobs] row parse failed: ${err.message}`);
        }
      }

      cursor = result?.has_more ? result.next_cursor : null;
    } while (cursor != null && page < MAX_PAGES);

    console.log(
      `[startupjobs] DONE — new=${newlyInserted}, existed=${alreadyExisted}, ` +
      `skipped_senior=${skippedSenior}, skipped_wrong_country=${skippedWrongCountry}, ` +
      `skipped_no_data=${skippedNoData}, skipped_dupe=${skippedCrossSourceDupe}, ` +
      `fetch_failed=${fetchFailed}`
    );

    // Reactivate-only — see file header: the API only surfaces the last 14
    // days, so listing-absence never proves a job closed. The 404 sweep
    // (startupjobs is in SWEEP_SOLE_DEACTIVATOR_SOURCES) owns deactivation.
    const rc = await reconcileActive(client, "startupjobs", foundUrls, { complete: false });
    console.log(`[startupjobs] active reconcile (reactivate-only) — ${JSON.stringify(rc)}`);
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
