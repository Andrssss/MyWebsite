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
*/

import { Pool } from "pg";
import https from "https";
import { loadFilters } from "./load_filters.mjs";
import { logFetchError, withTimeout } from "./_error-logger.mjs";
import { reconcileActive } from "./_active_core.mjs";

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
  const n = normalizeText(title ?? "");
  return _filters.some((kw) => _blacklistRegex(kw).test(n));
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
  const res = await client.query(
    `INSERT INTO job_posts (source, title, url, experience, first_seen)
     VALUES ($1,$2,$3,$4,NOW())
     ON CONFLICT (source, url) DO NOTHING
     RETURNING id;`,
    [source, item.title, item.url, item.experience ?? "-"]
  );
  return res.rowCount > 0;
}

/* ── handler ─────────────────────────────────────────────────── */

export default withTimeout("cron_jobs_ATLASZ-background", async () => {
  _filters = await loadFilters();
  const client = await pool.connect();

  let apiResult;
  try {
    apiResult = await postJson(API_URL, `job_ids[]=${IT_CAT_ID}`);
  } catch (err) {
    await logFetchError("cron_jobs_ATLASZ-background", { url: API_URL, message: err.message });
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
  const foundUrls = [];

  try {
    for (const job of jobs) {
      const title = normalizeWhitespace(job.position);
      if (!title) continue;

      if (normalizeText(job.location_city ?? "") !== "budapest") {
        skippedNonBudapest++;
        console.log(`[atlasz] SKIP non-Budapest "${title}" loc="${job.location_city}"`);
        continue;
      }

      if (isSeniorLike(title)) {
        skippedSenior++;
        console.log(`[atlasz] SKIP senior "${title}"`);
        continue;
      }

      const jobUrl = normalizeUrl(new URL(job.url, BASE).toString());

      const wasNew = await upsertJob(client, "atlasz", {
        title,
        url: jobUrl,
        experience: "diákmunka",
      });
      foundUrls.push(jobUrl);

      if (wasNew) {
        newlyInserted++;
        console.log(`[atlasz] NEW "${title}" → ${jobUrl}`);
      } else {
        alreadyExisted++;
        console.log(`[atlasz] EXISTS "${title}"`);
      }
    }

    console.log(
      `[atlasz] DONE — total=${jobs.length}, new=${newlyInserted}, existed=${alreadyExisted}, ` +
      `skipped_senior=${skippedSenior}, skipped_non_budapest=${skippedNonBudapest}`
    );

    // Single API response = full current listing.
    const rc = await reconcileActive(client, "atlasz", foundUrls, { complete: true });
    console.log(`[atlasz] active reconcile — ${JSON.stringify(rc)}`);
  } finally {
    client.release();
  }
});
