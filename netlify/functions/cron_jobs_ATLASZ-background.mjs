/*
  Atlasz Munkák – IT kategória scraper

  API endpoint: POST https://atlaszmunkak.hu/inc/jobsearch.php
  Body: job_ids[]=22  (22 = IT kategória)
  Returns JSON: { data: [{ position, location_city, url, ... }] }

  Flow:
    1. POST /inc/jobsearch.php?job_ids[]=22 → JSON jobs
    2. Filter location_city = "Budapest"
    3. Senior filter via _filters
    4. Upsert to job_posts (source = "atlasz", experience = "diákmunka" always — student job site)
    5. Detail-oldal (ad.php) fetch CSAK új url-re → technologies
*/

import { Pool } from "pg";
import https from "https";
import { loadFilters } from "./load_filters.mjs";
import { withTimeout } from "./_error-logger.mjs";
import { reconcileActive } from "./_active_core.mjs";
import { shouldSkipTitleFilter, seniorAwareExperience } from "./_seniority_policy.mjs";
import { computeLevel } from "../../src/lib/experienceLevel.mjs";
import { extractTechnologies, ensureTechnologiesColumn, ensureLevelColumn, fetchText, withTitleTechnologies } from "./_experience_core.mjs";
import { loadCrossSourceDupeIndex, isCrossSourceUrlDupe, CROSS_SOURCE_DUPE_SOURCES } from "./_cross_source_dupe.mjs";

let _filters = [];

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

const BASE = "https://atlaszmunkak.hu";
const API_URL = `${BASE}/inc/jobsearch.php`;
const IT_CAT_ID = "22";

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
    u.searchParams.delete("pnev");
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

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const postData = body;
    const parsedUrl = new URL(url);
    const req = https.request(
      parsedUrl,
      {
        method: "POST",
        headers: {
          "User-Agent": "Mozilla/5.0",
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(postData),
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
            catch { reject(new Error(`JSON parse error: ${data.slice(0, 100)}`)); }
          } else {
            reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          }
        });
        res.on("error", reject);
      }
    );
    req.on("timeout", () => req.destroy(new Error(`Timeout for ${url}`)));
    req.on("error", reject);
    req.write(postData);
    req.end();
  });
}

/* ── db ──────────────────────────────────────────────────────── */

async function upsertJob(client, source, item) {
  const experience = seniorAwareExperience(item.title, item.experience) ?? "-";
  const res = await client.query(
    `INSERT INTO job_posts (source, title, url, experience, technologies, level, first_seen)
     VALUES ($1,$2,$3,$4,$5,$6,NOW())
     ON CONFLICT (source, url) DO NOTHING
     RETURNING id;`,
    [
      source,
      item.title,
      item.url,
      experience,
      withTitleTechnologies(item.technologies, item.title),
      computeLevel({ title: item.title, experience, source }),
    ]
  );
  return res.rowCount > 0;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── handler ─────────────────────────────────────────────────── */

export default withTimeout("cron_jobs_ATLASZ-background", async () => {
  _filters = await loadFilters();
  const client = await pool.connect();

  let apiResult;
  try {
    apiResult = await postJson(API_URL, `job_ids[]=${IT_CAT_ID}`);
  } catch (err) {
    console.error(`[atlasz] API fetch failed: ${err.message}`);
    client.release();
    return;
  }

  const jobs = apiResult?.data ?? [];
  console.log(`[atlasz] API returned ${jobs.length} IT jobs`);

  let newlyInserted = 0;
  let alreadyExisted = 0;
  let skippedSenior = 0;
  let skippedNonBudapest = 0;
  let detailFetchFailed = 0;
  let skippedIncomplete = 0;
  const foundUrls = [];

  try {
    await ensureTechnologiesColumn(client);
    await ensureLevelColumn(client);

    // A jobsearch.php JSON csak cím/város/bér/óraszám — hirdetés-törzs nincs
    // benne, ezért maradt a technologies 2026-09-01-ig NULL. Az ad.php detail-
    // oldal viszont szerver-renderelt (élőben igazolva 2026-09-01), tehát csak
    // a fetch hiányzott. CSAK genuinely-új url-re megy le a kérés — a lenti
    // upsert ON CONFLICT DO NOTHING-ja meglévő sort úgysem írna felül.
    const knownUrls = new Set(
      (await client.query(`SELECT url FROM job_posts WHERE source = $1`, ["atlasz"])).rows.map((r) => r.url)
    );

    // Cross-source duplicate guard (2026-09-17, GH issue #18 follow-up) —
    // atlasz was never wired in. The jobsearch.php API carries no employer
    // field at all (see this file's header), so only the exact-url check
    // (isCrossSourceUrlDupe) is meaningful here — the fuzzy title+company key
    // can never match with company always null (dupeKey treats that as
    // "cannot compare", not a false negative).
    let skippedCrossSourceDupe = 0;
    const crossDupeIndex = await loadCrossSourceDupeIndex(client, "atlasz", { onlySources: CROSS_SOURCE_DUPE_SOURCES });
    console.log(`[atlasz] cross-source dupe index: ${crossDupeIndex.keySet.size} keys / ${crossDupeIndex.urlSet.size} urls`);

    for (const job of jobs) {
      const title = normalizeWhitespace(job.position);
      if (!title) continue;

      if (normalizeText(job.location_city ?? "") !== "budapest") {
        skippedNonBudapest++;
        console.log(`[atlasz] SKIP non-Budapest "${title}" loc="${job.location_city}"`);
        continue;
      }

      if (shouldSkipTitleFilter(title, _filters)) {
        skippedSenior++;
        console.log(`[atlasz] SKIP senior "${title}"`);
        continue;
      }

      const jobUrl = normalizeUrl(new URL(job.url, BASE).toString());

      if (!knownUrls.has(jobUrl) && isCrossSourceUrlDupe(crossDupeIndex, jobUrl)) {
        skippedCrossSourceDupe++;
        console.log(`[atlasz] SKIP exact-url dupe (already on another source) → ${jobUrl}`);
        continue;
      }

      // A teljes sor a beszúrás ELŐTT áll össze (nincs fetch-then-UPDATE).
      let technologies = null;
      if (!knownUrls.has(jobUrl)) {
        await sleep(500);
        try {
          technologies = extractTechnologies(await fetchText(jobUrl));
        } catch (err) {
          detailFetchFailed++;
          console.error(`[atlasz] technologies fetch failed ${jobUrl}: ${err.message}`);
        }
      }

      // Insert-only forrás (nincs utólagos UPDATE) — ha egy ÚJ sor detail-
      // fetchje technológiát sem adott, véglegesen csonka maradna (az
      // experience itt mindig "diákmunka", nem jelez hibát). Ehelyett
      // kihagyjuk (LinkedIn-minta, 2026-09-04/09-15 user-jelzés): a
      // foundUrls-be itt is bekerül, a `known`-ban viszont nincs benne, a
      // következő futás újnak látja és újrapróbálja.
      if (!knownUrls.has(jobUrl) && !technologies) {
        skippedIncomplete++;
        foundUrls.push(jobUrl);
        console.log(`[atlasz] SKIP incomplete detail fetch (no technologies) — retry later: ${jobUrl}`);
        continue;
      }

      const wasNew = await upsertJob(client, "atlasz", {
        title,
        url: jobUrl,
        experience: "diákmunka",
        technologies,
      });
      foundUrls.push(jobUrl);

      if (wasNew) {
        newlyInserted++;
        console.log(`[atlasz] NEW "${title}" tech=[${technologies ?? "-"}] → ${jobUrl}`);
      } else {
        alreadyExisted++;
        console.log(`[atlasz] EXISTS "${title}"`);
      }
    }

    console.log(
      `[atlasz] DONE — total=${jobs.length}, new=${newlyInserted}, existed=${alreadyExisted}, ` +
      `skipped_senior=${skippedSenior}, skipped_non_budapest=${skippedNonBudapest}, ` +
      `detail_fetch_failed=${detailFetchFailed}, skipped_incomplete=${skippedIncomplete}, ` +
      `skipped_cross_source_dupe=${skippedCrossSourceDupe}`
    );

    // Single API response = full current listing.
    const rc = await reconcileActive(client, "atlasz", foundUrls, { complete: true });
    console.log(`[atlasz] active reconcile — ${JSON.stringify(rc)}`);
  } finally {
    client.release();
  }
});
