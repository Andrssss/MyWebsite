/*
  Capgemini Jobstream API scraper

  Endpoint:
    https://cg-jobstream-api.azurewebsites.net/api/job-search?location=Budapest&page=1&size=11

  Flow:
    1. Fetch paginated API results for Budapest
    2. Skip senior-like titles based on loaded filters
    3. Extract experience from description HTML/text
    4. Upsert to job_posts (source = "cg-jobstream")
*/

import { Pool } from "pg";
import { loadFilters } from "./load_filters.mjs";
import { withTimeout } from "./_error-logger.mjs";
import { reconcileActive } from "./_active_core.mjs";
import { loadCrossSourceDupeIndex, isCrossSourceDupe, isCrossSourceUrlDupe, CROSS_SOURCE_DUPE_SOURCES } from "./_cross_source_dupe.mjs";
import { extractBodyExperience, extractTechnologies, ensureTechnologiesColumn, ensureLevelColumn, isInternshipTitle, isSeniorExperience, withTitleTechnologies } from "./_experience_core.mjs";
import { shouldSkipTitleFilter, shouldSkipSeniorExperience, seniorAwareExperience } from "./_seniority_policy.mjs";
import { computeLevel } from "../../src/lib/experienceLevel.mjs";

let _filters = [];

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

const SOURCE_KEY = "cg-jobstream";
const API_BASE = "https://cg-jobstream-api.azurewebsites.net/api/job-search";
const LOCATION = "Budapest";
const PAGE_SIZE = 50;
const MAX_PAGES = 30;

function normalizeText(v) {
  return String(v ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeWhitespace(v) {
  return String(v ?? "").replace(/\s+/g, " ").trim();
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

async function fetchPage(page) {
  const url = new URL(API_BASE);
  url.searchParams.set("location", LOCATION);
  url.searchParams.set("page", String(page));
  url.searchParams.set("size", String(PAGE_SIZE));

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "User-Agent": "JobWatcher/1.0",
      Accept: "application/json,text/plain;q=0.9,*/*;q=0.8",
      "Accept-Language": "hu-HU,hu;q=0.9,en;q=0.8",
    },
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }

  return res.json();
}

function mapItem(row) {
  const title = normalizeWhitespace(row?.title);
  const url = normalizeUrl(row?.apply_job_url || row?.wp_url || "");
  const description = row?.description || row?.description_stripped || "";

  if (!title || !url) return null;

  const experience = isInternshipTitle(title)
    ? "diákmunka"
    : extractBodyExperience(`<body>${description}</body>`) || "-";
  const technologies = extractTechnologies(`<body>${description}</body>`);

  return { title, url, experience, technologies };
}

const COMPANY_NAME = "Capgemini";

async function upsertJob(client, source, item) {
  const experience = seniorAwareExperience(item.title, item.experience) ?? "-";
  const res = await client.query(
    `INSERT INTO job_posts (source, title, url, experience, technologies, level, company, first_seen)
     VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
     ON CONFLICT (source, url) DO NOTHING
     RETURNING id;`,
    [source, item.title, item.url, experience, withTitleTechnologies(item.technologies, item.title), computeLevel({ title: item.title, experience, source }), COMPANY_NAME]
  );
  return res.rowCount > 0;
}

export default withTimeout("cron_jobs_CG-background", async () => {
  _filters = await loadFilters();

  const client = await pool.connect();
  await ensureTechnologiesColumn(client);
  await ensureLevelColumn(client);
  let newlyInserted = 0;
  let alreadyExisted = 0;
  let skippedSenior = 0;
  let skippedInvalid = 0;
  let fetched = 0;

  try {
    let crawlError = false;
    const collected = [];
    const seenUrl = new Set();

    for (let page = 1; page <= MAX_PAGES; page += 1) {
      let payload;
      try {
        payload = await fetchPage(page);
      } catch (err) {
        console.error(`[cg-jobstream] page ${page} fetch failed: ${err.message}`);
        crawlError = true;
        break;
      }

      const rows = Array.isArray(payload?.data) ? payload.data : [];
      const total = Number(payload?.count) || 0;
      fetched += rows.length;
      console.log(`[cg-jobstream] page ${page}: ${rows.length} rows (count=${total})`);

      if (rows.length === 0) break;

      for (const row of rows) {
        const item = mapItem(row);
        if (!item) {
          skippedInvalid += 1;
          continue;
        }
        if (shouldSkipTitleFilter(item.title, _filters) || shouldSkipSeniorExperience(isSeniorExperience(item.experience))) {
          skippedSenior += 1;
          continue;
        }
        if (seenUrl.has(item.url)) continue;
        seenUrl.add(item.url);
        collected.push(item);
      }

      if (total > 0 && page * PAGE_SIZE >= total) break;
      if (rows.length < PAGE_SIZE) break;
    }

    // GH issue #24 follow-up (2026-09-22): cg-jobstream was whitelisted in
    // CROSS_SOURCE_DUPE_SOURCES so every OTHER caller checks against its
    // rows, but cg-jobstream's own ingest never checked back — same gap
    // already fixed for kuka (see cross-source-dupe-coverage memory). A live
    // audit found real pairs this let through (e.g. "Medior Java Developer"
    // @ Capgemini re-listed on LinkedIn).
    const knownUrls = new Set(
      (await client.query(`SELECT url FROM job_posts WHERE source = $1`, [SOURCE_KEY])).rows.map((r) => r.url)
    );
    const crossDupeIndex = await loadCrossSourceDupeIndex(client, SOURCE_KEY, { onlySources: CROSS_SOURCE_DUPE_SOURCES });
    console.log(`[cg-jobstream] cross-source dupe index: ${crossDupeIndex.keySet.size} keys / ${crossDupeIndex.urlSet.size} urls`);

    let skippedCrossSourceDupe = 0;
    for (const item of collected) {
      if (!knownUrls.has(item.url) && isCrossSourceUrlDupe(crossDupeIndex, item.url)) {
        skippedCrossSourceDupe += 1;
        console.log(`[cg-jobstream] SKIP exact-url dupe (already on another source) → ${item.url}`);
        continue;
      }
      if (!knownUrls.has(item.url) && isCrossSourceDupe(crossDupeIndex, COMPANY_NAME, item.title)) {
        skippedCrossSourceDupe += 1;
        console.log(`[cg-jobstream] SKIP cross-source dupe "${item.title}" @ ${COMPANY_NAME} → ${item.url}`);
        continue;
      }
      const wasNew = await upsertJob(client, SOURCE_KEY, item);
      if (wasNew) {
        newlyInserted += 1;
        console.log(`[cg-jobstream] NEW \"${item.title}\" exp=${item.experience} -> ${item.url}`);
      } else {
        alreadyExisted += 1;
      }
    }

    console.log(
      `[cg-jobstream] DONE - fetched=${fetched}, candidates=${collected.length}, ` +
      `new=${newlyInserted}, existed=${alreadyExisted}, skipped_senior=${skippedSenior}, skipped_invalid=${skippedInvalid}, skipped_cross_source_dupe=${skippedCrossSourceDupe}`
    );

    const complete = !crawlError;
    const rc = await reconcileActive(client, SOURCE_KEY, collected.map((c) => c.url), { complete });
    console.log(`[cg-jobstream] active reconcile — complete=${complete}, ${JSON.stringify(rc)}`);
  } finally {
    client.release();
  }
});
