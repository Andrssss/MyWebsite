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
import { logFetchError, withTimeout } from "./_error-logger.mjs";
import { reconcileActive } from "./_active_core.mjs";
import { extractBodyExperience, isInternshipTitle } from "./_experience_core.mjs";

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
  const t = normalizeText(title ?? "");
  return _filters.some((kw) => _blacklistRegex(kw).test(t));
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

  return { title, url, experience };
}

async function upsertJob(client, source, item) {
  const canonicalUrl = normalizeUrl(item.url);
  const res = await client.query(
    `INSERT INTO job_posts (source, title, url, canonical_url, experience, first_seen)
     VALUES ($1,$2,$3,$4,$5,NOW())
     ON CONFLICT (source, url) DO NOTHING
     RETURNING id;`,
    [source, item.title, item.url, canonicalUrl, item.experience ?? "-"]
  );
  return res.rowCount > 0;
}

export default withTimeout("cron_jobs_CG-background", async () => {
  _filters = await loadFilters();

  const client = await pool.connect();
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
        await logFetchError("cron_jobs_CG-background", {
          url: `${API_BASE}?location=${encodeURIComponent(LOCATION)}&page=${page}&size=${PAGE_SIZE}`,
          message: err.message,
        });
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
        if (isSeniorLike(item.title)) {
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

    for (const item of collected) {
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
      `new=${newlyInserted}, existed=${alreadyExisted}, skipped_senior=${skippedSenior}, skipped_invalid=${skippedInvalid}`
    );

    const complete = !crawlError;
    const rc = await reconcileActive(client, SOURCE_KEY, collected.map((c) => c.url), { complete });
    console.log(`[cg-jobstream] active reconcile — complete=${complete}, ${JSON.stringify(rc)}`);
  } finally {
    client.release();
  }
});
