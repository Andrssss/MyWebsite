import { Pool } from "pg";
import https from "https";
import http from "http";
import zlib from "zlib";
import { load as cheerioLoad } from "cheerio";
import { loadFilters } from "./load_filters.mjs";
import { withTimeout } from "./_error-logger.mjs";
import {
  isInternshipTitle,
  isJuniorTitle,
  isMidLevelTitle,
  isSeniorExperience,
  extractTechnologies,
  ensureTechnologiesColumn,
} from "./_experience_core.mjs";
import { reconcileActive } from "./_active_core.mjs";
import { shouldSkipTitleFilter, shouldSkipSeniorExperience, seniorAwareExperience } from "./_seniority_policy.mjs";

const JOB_NAME = "cron_jobs_F_3-background";
const SOURCE = "workly";
const BASE = "https://workly.hu";
const FILTER_PARAMS = "show_results=1&query=&location=Budapest&primary_expertise%5B%5D=it-digital-technology";

let _filters = [];

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

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
    ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid"]
      .forEach((p) => u.searchParams.delete(p));
    return u.toString().replace(/\?$/, "");
  } catch {
    return raw;
  }
}

function _blacklistRegex(k) {
  const escaped = normalizeText(k).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i");
}

function isSeniorLike(title) {
  return shouldSkipTitleFilter(title, _filters);
}

function isWorklyJobUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname === "workly.hu" && u.pathname.startsWith("/allas/") && u.pathname.length > "/allas/".length;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Listing cards only carry a company logo image (alt=""), no text — the clean
// name only exists on the detail page (breadcrumb link + `.company-data-wrapper
// p.name`, both server-rendered, unlike minddiak's Angular SPA). Only called for
// brand-new urls, before insert (see experience-write-policy: no fetch-then-UPDATE
// on already-known rows).
function extractCompanyFromDetail(html) {
  const $ = cheerioLoad(html);
  const breadcrumbName = normalizeWhitespace($(".job-breadcrumb-wrapper a").first().text());
  if (breadcrumbName) return breadcrumbName.slice(0, 200);
  const dataName = normalizeWhitespace($(".company-data-wrapper p.name").first().text());
  if (dataName) return dataName.slice(0, 200);
  return null;
}

function detectExperience(title, cardText) {
  const c = normalizeText(cardText ?? "");
  if (isInternshipTitle(title) || c.includes("szakmai gyakorlat")) return "diákmunka";
  if (isJuniorTitle(title) || c.includes("junior")) return "junior";
  if (isMidLevelTitle(title) || c.includes("medior")) return "medior";
  return "-";
}

function fetchText(url, redirectLeft = 5) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(
      u,
      {
        method: "GET",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "hu-HU,hu;q=0.9,en;q=0.8",
          "Accept-Encoding": "gzip,deflate,br",
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
          return resolve(fetchText(new URL(loc, url).toString(), redirectLeft - 1));
        }
        const enc = String(res.headers["content-encoding"] || "").toLowerCase();
        let stream = res;
        if (enc.includes("gzip")) stream = res.pipe(zlib.createGunzip());
        else if (enc.includes("deflate")) stream = res.pipe(zlib.createInflate());
        else if (enc.includes("br")) stream = res.pipe(zlib.createBrotliDecompress());
        let data = "";
        stream.setEncoding("utf8");
        stream.on("data", (chunk) => (data += chunk));
        stream.on("end", () => {
          if (code >= 200 && code < 300) resolve(data);
          else reject(new Error(`HTTP ${code} for ${url}`));
        });
        stream.on("error", reject);
      }
    );
    req.on("timeout", () => req.destroy(new Error(`Timeout for ${url}`)));
    req.on("error", reject);
    req.end();
  });
}

/* ── listing page parser ─────────────────────────────────────── */

function extractJobEntries(html) {
  const $ = cheerioLoad(html);
  const entries = [];
  const seen = new Set();

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    let url;
    try {
      url = normalizeUrl(new URL(href, BASE).toString());
    } catch {
      return;
    }
    if (!isWorklyJobUrl(url)) return;
    if (seen.has(url)) return;
    seen.add(url);

    const title = normalizeWhitespace($(el).find("p.job-title").first().text());
    if (!title || title.length < 3) return;

    const cardText = normalizeWhitespace($(el).text());
    entries.push({ title, url, cardText });
  });

  return entries;
}

/* ── handler ─────────────────────────────────────────────────── */

export default withTimeout(JOB_NAME, async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  const expected = process.env.CRON_SECRET;
  if (!expected || token !== expected) {
    return new Response("Unauthorized", { status: 401 });
  }

  let startPage = 1;
  let maxPages = Infinity;
  try {
    const body = await request.json();
    if (typeof body.startPage === "number") startPage = body.startPage;
    if (typeof body.maxPages === "number") maxPages = body.maxPages;
  } catch {
    // no body or invalid JSON — use defaults
  }

  console.log(`[${JOB_NAME}] starting pages ${startPage}–${maxPages === Infinity ? "∞" : startPage + maxPages - 1}`);

  _filters = await loadFilters();
  const client = await pool.connect();
  await ensureTechnologiesColumn(client);
  const knownUrls = new Set(
    (await client.query(`SELECT url FROM job_posts WHERE source = $1`, [SOURCE])).rows.map((r) => r.url)
  );

  let newlyInserted = 0;
  let alreadyExisted = 0;
  let skippedSenior = 0;
  const foundUrls = [];
  let crawlError = false;

  try {
    let page = startPage;
    let pagesProcessed = 0;

    while (pagesProcessed < maxPages) {
      const pageUrl = page === 1
        ? `${BASE}/allasok/?${FILTER_PARAMS}`
        : `${BASE}/allasok/page/${page}/?${FILTER_PARAMS}`;

      let html;
      try {
        html = await fetchText(pageUrl);
      } catch (err) {
        if (String(err?.message || "").includes("HTTP 404")) {
          console.log(`[workly] pagination stopped at page ${page} (404)`);
          break;
        }
        console.error(`[workly] page ${page} fetch failed: ${err.message}`);
        crawlError = true;
        break;
      }

      const entries = extractJobEntries(html);
      console.log(`[workly] page ${page} → ${entries.length} job links`);

      if (entries.length === 0) {
        console.log(`[workly] page ${page} empty — stopping`);
        break;
      }

      for (const entry of entries) {
        if (shouldSkipTitleFilter(entry.title, _filters)) {
          skippedSenior++;
          console.log(`[workly] SKIP senior "${entry.title}"`);
          continue;
        }

        const experience = detectExperience(entry.title, entry.cardText);
        if (shouldSkipSeniorExperience(isSeniorExperience(experience))) {
          skippedSenior++;
          console.log(`[workly] SKIP senior-experience [${experience}] "${entry.title}"`);
          continue;
        }
        foundUrls.push(entry.url);

        // Ugyanaz az EGY detail-fetch adja a céget és a technologies-t is —
        // a html már a kezünkben van, nincs plusz kérés. (2026-09-01-ig csak a
        // company olvasódott ki belőle, a technologies oszlop az INSERT-listán
        // sem szerepelt, így a workly örökre NULL maradt.)
        let company = null;
        let technologies = null;
        if (!knownUrls.has(entry.url)) {
          try {
            await sleep(500);
            const detailHtml = await fetchText(entry.url);
            company = extractCompanyFromDetail(detailHtml);
            technologies = extractTechnologies(detailHtml);
          } catch (err) {
            console.warn(`[workly] detail fetch failed: ${entry.url} — ${err.message}`);
          }
        }

        const res = await client.query(
          `INSERT INTO job_posts (source, title, url, experience, company, technologies, first_seen)
           VALUES ($1,$2,$3,$4,$5,$6,NOW())
           ON CONFLICT (source, url) DO NOTHING
           RETURNING id;`,
          [SOURCE, entry.title, entry.url, seniorAwareExperience(entry.title, experience), company, technologies]
        );
        if (res.rowCount > 0) {
          newlyInserted++;
          console.log(`[workly] NEW "${entry.title}" tech=[${technologies ?? "-"}] → ${entry.url}`);
        } else {
          alreadyExisted++;
        }
      }

      page++;
      pagesProcessed++;
    }

    console.log(`[workly] DONE — new=${newlyInserted}, existed=${alreadyExisted}, skipped_senior=${skippedSenior}`);

    // Reconcile active flag only on a full, error-free crawl from page 1 — a
    // partial/limited run would wrongly deactivate jobs on the unseen pages.
    const complete = startPage === 1 && maxPages === Infinity && !crawlError;
    const rc = await reconcileActive(client, SOURCE, foundUrls, { complete });
    console.log(`[workly] active reconcile — complete=${complete}, ${JSON.stringify(rc)}`);
  } finally {
    client.release();
  }

  return new Response("OK");
});
