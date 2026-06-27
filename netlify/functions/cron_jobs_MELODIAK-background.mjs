/*
  MelóDiák – IT kategória scraper

  API: GET https://web-api.melodiak.hu/v1/job-advertisement?page=N
  Returns 50 jobs/page, no server-side category filter — client-side filter needed.
  Filter: category.slug === "informatikai-mernoki-muszaki" && city_name === "Budapest"
  Job URL: https://www.melodiak.hu/diakmunkak/{slug}

  Flow:
    1. Paginate GET /v1/job-advertisement until empty page
    2. Filter IT + Budapest client-side
    3. Senior filter via _filters
    4. Upsert (source = "melodiak", experience = "diákmunka")
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

const BASE = "https://www.melodiak.hu";
const API_BASE = "https://web-api.melodiak.hu/v1/job-advertisement";
const IT_SLUG = "informatikai-mernoki-muszaki";

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

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const req = https.request(
      parsedUrl,
      {
        method: "GET",
        headers: {
          "User-Agent": "Mozilla/5.0",
          Accept: "application/json",
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
            catch { reject(new Error(`JSON parse error at ${url}`)); }
          } else {
            reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          }
        });
        res.on("error", reject);
      }
    );
    req.on("timeout", () => req.destroy(new Error(`Timeout for ${url}`)));
    req.on("error", reject);
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

export default withTimeout("cron_jobs_MELODIAK-background", async () => {
  _filters = await loadFilters();
  const client = await pool.connect();

  let newlyInserted = 0;
  let alreadyExisted = 0;
  let skippedSenior = 0;
  let totalFetched = 0;
  let fetchFailed = 0;

  try {
    const foundUrls = [];
    for (let page = 1; page <= 20; page++) {
      let result;
      try {
        await sleep(500);
        result = await fetchJson(`${API_BASE}?page=${page}`);
      } catch (err) {
        fetchFailed++;
        await logFetchError("cron_jobs_MELODIAK-background", { url: `${API_BASE}?page=${page}`, message: err.message });
        console.error(`[melodiak] page ${page} fetch failed: ${err.message}`);
        break;
      }

      const jobs = result?.data?.resource ?? [];
      if (jobs.length === 0) {
        console.log(`[melodiak] page ${page} empty, done`);
        break;
      }

      totalFetched += jobs.length;

      for (const job of jobs) {
        const catSlug = job.category?.slug ?? "";
        if (catSlug !== IT_SLUG) continue;
        if (normalizeText(job.city_name ?? "") !== "budapest") continue;

        const title = normalizeWhitespace(job.title);
        if (!title) continue;

        if (isSeniorLike(title)) {
          skippedSenior++;
          console.log(`[melodiak] SKIP senior "${title}"`);
          continue;
        }

        const jobUrl = `${BASE}/diakmunkak/${job.slug}`;

        const wasNew = await upsertJob(client, "melodiak", {
          title,
          url: jobUrl,
          experience: "diákmunka",
        });
        foundUrls.push(jobUrl);

        if (wasNew) {
          newlyInserted++;
          console.log(`[melodiak] NEW "${title}" → ${jobUrl}`);
        } else {
          alreadyExisted++;
          console.log(`[melodiak] EXISTS "${title}"`);
        }
      }
    }

    console.log(
      `[melodiak] DONE — fetched=${totalFetched}, new=${newlyInserted}, existed=${alreadyExisted}, ` +
      `skipped_senior=${skippedSenior}, fetch_failed=${fetchFailed}`
    );

    const complete = fetchFailed === 0;
    const rc = await reconcileActive(client, "melodiak", foundUrls, { complete });
    console.log(`[melodiak] active reconcile — complete=${complete}, ${JSON.stringify(rc)}`);
  } finally {
    client.release();
  }
});
