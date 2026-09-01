/*
  MBH Bank karrier oldal scraper
  List URLs:
    https://karrier.mbhbank.hu/DataCenter/Registration/JobAdvertisements/it?p=64
    https://karrier.mbhbank.hu/DataCenter/Registration/JobAdvertisements/gyakornok?p=64
    https://karrier.mbhbank.hu/DataCenter/Registration/JobAdvertisements/gyakornok

  Flow:
    1. Fetch each list page → extract /JobAdvertisement/ links
    2. Fetch each detail page
    3. Parse "Munkavégzés helye:" → skip if not Budapest
    4. extractBodyExperience → experience field
    5. Filter seniors via _filters
    6. Upsert to job_posts
*/

import { Pool } from "pg";
import https from "https";
import http from "http";
import zlib from "zlib";
import { load as cheerioLoad } from "cheerio";
import { loadFilters } from "./load_filters.mjs";
import { withTimeout } from "./_error-logger.mjs";
import { extractBodyExperience, extractTechnologies, ensureTechnologiesColumn, isInternshipTitle, isJuniorTitle, isMidLevelTitle, isSeniorExperience } from "./_experience_core.mjs";
import { reconcileActive, migrateVolatileUrl, escapeRegex } from "./_active_core.mjs";
import { shouldSkipTitleFilter, shouldSkipSeniorExperience, seniorAwareExperience } from "./_seniority_policy.mjs";

let _filters = [];

// /JobAdvertisement/{id}/{slug}/{cat} — same HRmaster platform as MFB, where the
// embedded numeric id ROTATES when the posting is refreshed (confirmed on MFB:
// /339/linux-rendszermernok → /345/…). No MBH churn pair in the DB yet, but the
// mechanism is identical, so guard proactively.
function volatileUrlPattern(url) {
  const m = url.match(/^(.*\/JobAdvertisement\/)\d+(\/.+)$/);
  return m ? `^${escapeRegex(m[1])}\\d+${escapeRegex(m[2])}$` : null;
}

// The OPPOSITE churn also happens, and it is the one MBH actually does: the id
// stays put while the SLUG is regenerated from an edited title. Live evidence
// 2026-08-26: JobAdvertisement/22208/informaciobiztonsagi-gyakornok--es-
// projekttamogatasi-gyakornok/gyakornok was re-slugged to
// .../22208/informaciobiztonsagi--es-projekttamogatasi-gyakornok/gyakornok —
// same id, one word dropped. volatileUrlPattern above holds the SLUG fixed and
// wildcards the id, so it cannot match: the old row was orphaned (left
// inactive, still HTTP 200) while a duplicate row was inserted for what is one
// posting. Same bug and same fallback erste grew on 2026-07-22 — match ANY mbh
// url carrying this id, whatever the slug. Ids are unique per source, and
// migrateVolatileUrl never touches a url still present in the live listing, so
// this cannot over-match.
function idOnlyPattern(url) {
  const m = url.match(/\/JobAdvertisement\/(\d+)\//);
  return m ? escapeRegex(`/JobAdvertisement/${m[1]}/`) : null;
}

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

const BASE = "https://karrier.mbhbank.hu";
const API = `${BASE}/Datacenter/Registration/GetPositionsBySearchDto`;

// Each LIST_SOURCES entry sets its own `regsite` cookie via the list page,
// then POSTs to the API to get the rendered HTML fragment with all jobs.
const LIST_SOURCES = [
  {
    listUrl: `${BASE}/DataCenter/Registration/JobAdvertisements/it?p=64`,
    regsite: "it",
    positionGroupIdList: [64],
  },
  {
    listUrl: `${BASE}/DataCenter/Registration/JobAdvertisements/gyakornok`,
    regsite: "gyakornok",
    positionGroupIdList: [], // empty = all departments (not just IT) so cross-dept interns are found
  },
];

/* ── helpers ─────────────────────────────────────────────────── */

function normalizeWhitespace(v) {
  return String(v ?? "").replace(/\s+/g, " ").trim();
}

function normalizeText(v) {
  return String(v ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function _blacklistRegex(k) {
  const escaped = normalizeText(k).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i");
}

function isSeniorLike(title) {
  return shouldSkipTitleFilter(title, _filters);
}

function fetchText(url, redirectLeft = 5, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const lib = parsedUrl.protocol === "https:" ? https : http;

    const req = lib.request(
      parsedUrl,
      {
        method: "GET",
        headers: {
          "User-Agent": "JobWatcher/1.0",
          Accept: "text/html,*/*;q=0.8",
          "Accept-Language": "hu-HU,hu;q=0.9,en;q=0.8",
          "Accept-Encoding": "gzip,deflate,br",
          ...extraHeaders,
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
          return resolve(fetchText(new URL(loc, url).toString(), redirectLeft - 1, extraHeaders));
        }

        const enc = String(res.headers["content-encoding"] || "").toLowerCase();
        let stream = res;
        if (enc.includes("gzip")) stream = res.pipe(zlib.createGunzip());
        else if (enc.includes("deflate")) stream = res.pipe(zlib.createInflate());
        else if (enc.includes("br")) stream = res.pipe(zlib.createBrotliDecompress());

        let body = "";
        stream.setEncoding("utf8");
        stream.on("data", (c) => (body += c));
        stream.on("end", () =>
          code >= 200 && code < 300
            ? resolve(body)
            : reject(new Error(`HTTP ${code} for ${url}`))
        );
        stream.on("error", reject);
      }
    );

    req.on("timeout", () => req.destroy(new Error(`Timeout for ${url}`)));
    req.on("error", reject);
    req.end();
  });
}

function postJson(url, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const lib = parsedUrl.protocol === "https:" ? https : http;
    const req = lib.request(
      parsedUrl,
      {
        method: "POST",
        headers: {
          "User-Agent": "JobWatcher/1.0",
          Accept: "*/*",
          "Accept-Language": "hu-HU,hu;q=0.9,en;q=0.8",
          "Accept-Encoding": "gzip,deflate,br",
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": Buffer.byteLength(body),
          "X-Requested-With": "XMLHttpRequest",
          ...extraHeaders,
        },
        timeout: 25000,
      },
      (res) => {
        const code = res.statusCode || 0;
        const enc = String(res.headers["content-encoding"] || "").toLowerCase();
        let stream = res;
        if (enc.includes("gzip")) stream = res.pipe(zlib.createGunzip());
        else if (enc.includes("deflate")) stream = res.pipe(zlib.createInflate());
        else if (enc.includes("br")) stream = res.pipe(zlib.createBrotliDecompress());
        let buf = "";
        stream.setEncoding("utf8");
        stream.on("data", (c) => (buf += c));
        stream.on("end", () =>
          code >= 200 && code < 300
            ? resolve(buf)
            : reject(new Error(`HTTP ${code} for ${url}`))
        );
        stream.on("error", reject);
      }
    );
    req.on("timeout", () => req.destroy(new Error(`Timeout for ${url}`)));
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/* ── list page parser ────────────────────────────────────────── */

function extractJobLinks(html, baseUrl) {
  const $ = cheerioLoad(html);
  const links = new Set();

  // API response uses data-position-url attributes, not <a href>
  $("[data-position-url]").each((_, el) => {
    const raw = $(el).attr("data-position-url");
    if (!raw) return;
    try {
      const full = new URL(raw, baseUrl).toString();
      if (/\/JobAdvertisement\/\d+\//i.test(full)) {
        links.add(normalizeUrl(full));
      }
    } catch {
      // ignore malformed
    }
  });

  return [...links];
}

/* ── detail page parser ──────────────────────────────────────── */

// Returns { title, experience } or null if not Budapest
function parseDetailPage(html) {
  const $ = cheerioLoad(html);
  const bodyText = normalizeWhitespace($("body").text());

  const locationMatch = bodyText.match(/munkav[eé]gz[eé]s\s+helye\s*:?\s*([^\n|]+)/i);
  const location = locationMatch ? locationMatch[1].trim() : "";

  if (!location.toLowerCase().includes("budapest")) return null;

  const title = normalizeWhitespace($("h1").first().text());
  let experience;
  if (isInternshipTitle(title)) {
    experience = "diákmunka";
  } else if (isJuniorTitle(title)) {
    experience = "junior";
  } else if (isMidLevelTitle(title)) {
    experience = "medior";
  } else {
    experience = extractBodyExperience(html);
  }
  const technologies = extractTechnologies(html);

  return { title, experience, technologies };
}

/* ── db ──────────────────────────────────────────────────────── */

async function upsertJob(client, source, item) {
  const res = await client.query(
    `INSERT INTO job_posts (source, title, url, experience, technologies, first_seen)
     VALUES ($1,$2,$3,$4,$5,NOW())
     ON CONFLICT (source, url) DO NOTHING
     RETURNING id;`,
    [source, item.title, item.url, seniorAwareExperience(item.title, item.experience) ?? "-", item.technologies ?? null]
  );
  return res.rowCount > 0; // true = newly inserted, false = duplicate
}

/* ── handler ─────────────────────────────────────────────────── */

export default withTimeout("cron_jobs_MBH-background", async () => {
  _filters = await loadFilters();
  const client = await pool.connect();

  try {
    await ensureTechnologiesColumn(client);
    // Collect unique detail URLs across all list sources; first wins on duplicate
    const jobSet = new Set();
    let listFetchFailed = false;

    for (const { listUrl, regsite, positionGroupIdList } of LIST_SOURCES) {
      try {
        const cookie = `regsite=${regsite}`;
        // Prime the cookie (server may also need to know we visited the list page)
        await fetchText(listUrl, 5, { Cookie: cookie }).catch(() => {});

        const body = JSON.stringify({
          searchDto: {
            searchText: "",
            careerLevelTypeIdList: [],
            locationOfWorkTypeIdList: [],
            styleOfWorkTypeIdList: [],
            positionGroupIdList,
            qualificationTypeIdList: [],
            corporationIdList: [],
            categoryTypeIdList: [],
            languageWithLevelIdList: [],
            isLanguageConnectionAnd: null,
            positionGroupId: null,
          },
        });

        const html = await postJson(API, body, { Referer: listUrl, Cookie: cookie });
        const links = extractJobLinks(html, BASE);
        console.log(`[mbh] list regsite=${regsite}: ${links.length} links`);

        for (const link of links) jobSet.add(link);

        await sleep(1000);
      } catch (err) {
        listFetchFailed = true;
        console.error(`[mbh] list fetch failed ${listUrl}: ${err.message}`);
      }
    }

    console.log(`[mbh] total unique job links: ${jobSet.size}`);

    let newlyInserted = 0;
    let alreadyExisted = 0;
    let skippedSenior = 0;
    let skippedNoTitle = 0;
    let notBudapest = 0;
    let detailFetchFailed = 0;
    const foundUrls = [];

    for (const detailUrl of jobSet) {
      try {
        await sleep(800);
        const html = await fetchText(detailUrl);
        const parsed = parseDetailPage(html);

        if (!parsed) {
          notBudapest++;
          console.log(`[mbh] SKIP not-Budapest → ${detailUrl}`);
          continue;
        }

        if (!parsed.title) {
          skippedNoTitle++;
          console.log(`[mbh] SKIP no-title → ${detailUrl}`);
          continue;
        }

        if (shouldSkipTitleFilter(parsed.title, _filters) || shouldSkipSeniorExperience(isSeniorExperience(parsed.experience))) {
          skippedSenior++;
          console.log(`[mbh] SKIP senior "${parsed.title}" → ${detailUrl}`);
          continue;
        }

        const pattern = volatileUrlPattern(detailUrl);
        let migrated = pattern
          ? await migrateVolatileUrl(client, "mbh", detailUrl, pattern, [...jobSet])
          : false;
        if (!migrated) {
          const idPattern = idOnlyPattern(detailUrl);
          if (idPattern) migrated = await migrateVolatileUrl(client, "mbh", detailUrl, idPattern, [...jobSet]);
        }
        if (migrated) console.log(`[mbh] MIGRATED url → ${detailUrl}`);
        const wasNew = await upsertJob(client, "mbh", {
          title: parsed.title,
          url: detailUrl,
          experience: parsed.experience,
          technologies: parsed.technologies,
        });
        foundUrls.push(detailUrl);

        if (wasNew) {
          newlyInserted++;
          console.log(
            `[mbh] NEW "${parsed.title}" exp=${parsed.experience ?? "-"} → ${detailUrl}`
          );
        } else {
          alreadyExisted++;
          console.log(`[mbh] EXISTS "${parsed.title}" → ${detailUrl}`);
        }
      } catch (err) {
        // The job's EXISTENCE is proven by the list (jobSet); the detail fetch
        // only supplies title/experience. Still push the url to foundUrls so a
        // flaky detail can't get a live job deactivated by reconcile.
        detailFetchFailed++;
        foundUrls.push(detailUrl);
        console.error(`[mbh] detail fetch failed ${detailUrl}: ${err.message}`);
      }
    }

    console.log(
      `[mbh] DONE — total=${jobSet.size}, new=${newlyInserted}, existed=${alreadyExisted}, ` +
      `skipped_senior=${skippedSenior}, skipped_no_title=${skippedNoTitle}, ` +
      `not_budapest=${notBudapest}, fetch_failed=${detailFetchFailed}`
    );

    // Reconcile active flag: detail failures no longer block deactivation (the
    // failed url stays in foundUrls), only a failed LIST fetch does.
    const complete = !listFetchFailed;
    const rc = await reconcileActive(client, "mbh", foundUrls, { complete });
    console.log(`[mbh] active reconcile — complete=${complete}, ${JSON.stringify(rc)}`);
  } finally {
    client.release();
  }
});
