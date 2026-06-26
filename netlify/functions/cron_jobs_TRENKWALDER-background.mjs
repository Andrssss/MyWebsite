/*
  Trenkwalder HU – Budapest / IT-Szoftverfejlesztés scraper

  API: Algolia REST API
    appId:    02IH9HMLGA
    apiKey:   b885435a7745a7fd4c7637560f35f48a  (search-only, public)
    index:    PROD_HU_New_Index_1_date
    endpoint: POST https://02IH9HMLGA-dsn.algolia.net/1/indexes/PROD_HU_New_Index_1_date/query

  Query:
    filters:       publishingStatus:Published
    facetFilters:  jobObject.jobCategory.national:IT/Szoftverfejlesztés
    aroundLatLng:  47.497912,19.040235 (Budapest center)
    aroundRadius:  25000 (25 km)

  Flow:
    1. Paginate Algolia query until no more hits
    2. Extract title (hit.jobObject.title) + URL (hit.web.jobUrl)
    3. Senior filter via _filters
    4. Upsert (source = "trenkwalder")
*/

import { Pool } from "pg";
import https from "https";
import { loadFilters } from "./load_filters.mjs";
import { logFetchError, withTimeout } from "./_error-logger.mjs";
import { reconcileActive } from "./_active_core.mjs";
import { isInternshipTitle, isJuniorTitle, isMidLevelTitle } from "./_experience_core.mjs";

let _filters = [];

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

const ALGOLIA_APP_ID = "02IH9HMLGA";
const ALGOLIA_API_KEY = "b885435a7745a7fd4c7637560f35f48a";
const ALGOLIA_INDEX = "PROD_HU_New_Index_1_date";
const ALGOLIA_HOST = `${ALGOLIA_APP_ID}-dsn.algolia.net`;

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

function _blacklistRegex(k) {
  const escaped = normalizeText(k).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i");
}

function isSeniorLike(title) {
  const n = normalizeText(title ?? "");
  return _filters.some((kw) => _blacklistRegex(kw).test(n));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function algoliaSearch(page) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      query: "",
      filters: "publishingStatus:Published",
      facetFilters: [["jobObject.jobCategory.national:IT/Szoftverfejlesztés"]],
      aroundLatLng: "47.497912,19.040235",
      aroundRadius: 25000,
      hitsPerPage: 100,
      page,
    });

    const req = https.request(
      {
        hostname: ALGOLIA_HOST,
        path: `/1/indexes/${ALGOLIA_INDEX}/query`,
        method: "POST",
        headers: {
          "X-Algolia-Application-Id": ALGOLIA_APP_ID,
          "X-Algolia-API-Key": ALGOLIA_API_KEY,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: 25000,
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(data)); }
            catch { reject(new Error(`JSON parse error at page ${page}`)); }
          } else {
            reject(new Error(`HTTP ${res.statusCode} at page ${page}: ${data.slice(0, 200)}`));
          }
        });
        res.on("error", reject);
      }
    );
    req.on("timeout", () => req.destroy(new Error(`Algolia timeout page ${page}`)));
    req.on("error", reject);
    req.end(body);
  });
}

/* ── db ──────────────────────────────────────────────────────── */

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

/* ── handler ─────────────────────────────────────────────────── */

export default withTimeout("cron_jobs_TRENKWALDER-background", async () => {
  _filters = await loadFilters();
  const client = await pool.connect();

  let newlyInserted = 0;
  let alreadyExisted = 0;
  let skippedSenior = 0;
  let fetchFailed = 0;
  const seen = new Set();

  try {
    const foundUrls = [];
    for (let page = 0; page < 10; page++) {
      let result;
      try {
        await sleep(300);
        result = await algoliaSearch(page);
      } catch (err) {
        fetchFailed++;
        await logFetchError("cron_jobs_TRENKWALDER-background", {
          url: `algolia:${ALGOLIA_INDEX}:page=${page}`,
          message: err.message,
        });
        console.error(`[trenkwalder] algolia page ${page} failed: ${err.message}`);
        break;
      }

      const hits = result.hits ?? [];
      console.log(`[trenkwalder] page ${page}: ${hits.length} hits (nbHits=${result.nbHits})`);
      if (hits.length === 0) break;

      for (const hit of hits) {
        const jobUrl = hit.web?.jobUrl;
        if (!jobUrl) continue;
        const url = normalizeUrl(jobUrl);
        if (seen.has(url)) continue;
        seen.add(url);

        const title = normalizeWhitespace(hit.jobObject?.title ?? "");
        if (!title) continue;

        if (isSeniorLike(title)) {
          skippedSenior++;
          console.log(`[trenkwalder] SKIP senior "${title}"`);
          continue;
        }

        // Experience: check tags for "Student", otherwise check title
        const isStudent = hit.web?.tags?.some((t) => t.en === "Student");
        const experience = isStudent || isInternshipTitle(title) ? "diákmunka"
          : isJuniorTitle(title) ? "junior"
          : isMidLevelTitle(title) ? "medior"
          : "-";

        const wasNew = await upsertJob(client, "trenkwalder", { title, url, experience });
        foundUrls.push(url);
        if (wasNew) {
          newlyInserted++;
          console.log(`[trenkwalder] NEW "${title}" exp=${experience} → ${url}`);
        } else {
          alreadyExisted++;
          console.log(`[trenkwalder] EXISTS "${title}"`);
        }
      }

      // Stop if we've seen all pages
      if (page >= (result.nbPages ?? 1) - 1) break;
    }

    console.log(
      `[trenkwalder] DONE — new=${newlyInserted}, existed=${alreadyExisted}, ` +
      `skipped_senior=${skippedSenior}, fetch_failed=${fetchFailed}`
    );

    const complete = fetchFailed === 0;
    const rc = await reconcileActive(client, "trenkwalder", foundUrls, { complete });
    console.log(`[trenkwalder] active reconcile — complete=${complete}, ${JSON.stringify(rc)}`);
  } finally {
    client.release();
  }
});
