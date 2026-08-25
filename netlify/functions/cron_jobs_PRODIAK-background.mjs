/*
  Prodiák (Prohuman Diákmunka) – IT/Budapest scraper

  API: POST https://www.prodiak.hu/api/adverts?page=N   body: {}
       Returns { adverts: { current_page, last_page, data: [...] } }.
       No working server-side category/location filter was found (the
       Vue app's own filter payload 500'd on every shape tried) — with only
       ~130 total postings across ~22 pages, pulling everything and
       filtering client-side is cheap and avoids guessing at an undocumented
       request shape.
  Filter: item.type === "IT" && a location string looks like a Budapest
          district ("… kerület") or literally mentions "Budapest".
  Job URL: https://www.prodiak.hu/allas/{slug}/{index_id}
           (detail page server-renders a schema.org JobPosting block incl.
           validThrough — confirmed 2026-07-22 that an expired posting stays
           fully viewable with no visible banner, so `active` here must come
           from listing presence, same as most other sources; never assume a
           reachable detail page means open.)

  Previously an orphan source (grep-confirmed no scraper existed anywhere in
  this repo — job_posts had historical rows nothing could ever reconcile).
*/

import { Pool } from "pg";
import https from "https";
import { loadFilters } from "./load_filters.mjs";
import { logFetchError, withTimeout } from "./_error-logger.mjs";
import { reconcileActive } from "./_active_core.mjs";
import { isInternshipTitle } from "./_experience_core.mjs";
import { shouldSkipTitleFilter, seniorAwareExperience } from "./_seniority_policy.mjs";

let _filters = [];

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

const BASE = "https://www.prodiak.hu";
const API = `${BASE}/api/adverts`;
const MAX_PAGES = 40; // real total is ~22; capped as a safety valve, not a working limit

/* ── helpers ─────────────────────────────────────────────────── */

function normalizeText(v) {
  return String(v ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeWhitespace(v) {
  return String(v ?? "").replace(/\s+/g, " ").trim();
}

function _blacklistRegex(k) {
  const escaped = normalizeText(k).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i");
}

function isSeniorLike(title) {
  return shouldSkipTitleFilter(title, _filters);
}

function isBudapestLocation(locations) {
  return (Array.isArray(locations) ? locations : []).some(
    (l) => /kerület/i.test(l) || /budapest/i.test(l)
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const payload = JSON.stringify(body);
    const req = https.request(
      parsedUrl,
      {
        method: "POST",
        headers: {
          "User-Agent": "Mozilla/5.0",
          Accept: "application/json",
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
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
    req.write(payload);
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
    [source, item.title, item.url, seniorAwareExperience(item.title, item.experience) ?? "-"]
  );
  return res.rowCount > 0;
}

/* ── handler ─────────────────────────────────────────────────── */

export default withTimeout("cron_jobs_PRODIAK-background", async () => {
  _filters = await loadFilters();
  const client = await pool.connect();

  let newlyInserted = 0;
  let alreadyExisted = 0;
  let skippedSenior = 0;
  let totalFetched = 0;
  let fetchFailed = false;

  try {
    const foundUrls = [];
    let page = 1;
    let lastPage = 1;

    do {
      let result;
      try {
        await sleep(300);
        result = await postJson(`${API}?page=${page}`, {});
      } catch (err) {
        fetchFailed = true;
        await logFetchError("cron_jobs_PRODIAK-background", { url: `${API}?page=${page}`, message: err.message });
        console.error(`[prodiak] page ${page} fetch failed: ${err.message}`);
        break;
      }

      const adverts = result?.adverts;
      const rows = Array.isArray(adverts?.data) ? adverts.data : [];
      lastPage = adverts?.last_page || page;
      console.log(`[prodiak] page ${page}/${lastPage}: ${rows.length} jobs`);
      totalFetched += rows.length;

      for (const job of rows) {
        if (job.type !== "IT") continue;
        if (!isBudapestLocation(job.locations)) continue;

        const title = normalizeWhitespace(job.name);
        if (!title || !job.slug || !job.index_id) continue;

        if (shouldSkipTitleFilter(title, _filters)) {
          skippedSenior++;
          console.log(`[prodiak] SKIP senior "${title}"`);
          continue;
        }

        const jobUrl = `${BASE}/allas/${job.slug}/${job.index_id}`;
        const experience = isInternshipTitle(title) ? "diákmunka" : "-";

        const wasNew = await upsertJob(client, "prodiak", { title, url: jobUrl, experience });
        foundUrls.push(jobUrl);

        if (wasNew) {
          newlyInserted++;
          console.log(`[prodiak] NEW "${title}" → ${jobUrl}`);
        } else {
          alreadyExisted++;
          console.log(`[prodiak] EXISTS "${title}"`);
        }
      }

      page++;
    } while (page <= lastPage && page <= MAX_PAGES);

    console.log(
      `[prodiak] DONE — fetched=${totalFetched}, new=${newlyInserted}, existed=${alreadyExisted}, ` +
      `skipped_senior=${skippedSenior}, fetch_failed=${fetchFailed}`
    );

    const complete = !fetchFailed;
    const rc = await reconcileActive(client, "prodiak", foundUrls, { complete });
    console.log(`[prodiak] active reconcile — complete=${complete}, ${JSON.stringify(rc)}`);
  } finally {
    client.release();
  }
});
