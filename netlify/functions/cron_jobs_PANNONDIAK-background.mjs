/*
  PannonDiák – IT (category 1845) / Budapest scraper

  API: POST https://pannondiak.hu/jobs/ajaxSearch
  Body: where=Budapest&category[]=1845&page=N&perPage=50
  Response: { counter, jobs: [], view: "<HTML cards>" }
  Title: article.card h3.card-title
  URL: article.card .card-body a[href*="/allas/"]

  Flow:
    1. Paginate POST /jobs/ajaxSearch until view is empty
    2. Parse view HTML → extract title + canonical URL per card
    3. Dedup by URL (Set)
    4. Senior filter via _filters
    5. Upsert (source = "pannondiak", experience = "diákmunka")
*/

import { Pool } from "pg";
import https from "https";
import { load as cheerioLoad } from "cheerio";
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

const BASE = "https://pannondiak.hu";
const SEARCH_URL = `${BASE}/jobs/ajaxSearch`;
const IT_CATEGORY = "1845";

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

function postSearch(page) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      where: "Budapest",
      page: String(page),
      perPage: "50",
    });
    params.append("category[]", IT_CATEGORY);
    const body = params.toString();

    const req = https.request(
      new URL(SEARCH_URL),
      {
        method: "POST",
        headers: {
          "User-Agent": "Mozilla/5.0",
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
          "Accept": "application/json, */*",
          "X-Requested-With": "XMLHttpRequest",
          "Referer": `${BASE}/allas`,
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
            reject(new Error(`HTTP ${res.statusCode} for page ${page}`));
          }
        });
        res.on("error", reject);
      }
    );
    req.on("timeout", () => req.destroy(new Error(`Timeout at page ${page}`)));
    req.on("error", reject);
    req.end(body);
  });
}

function parseCards(viewHtml) {
  const $ = cheerioLoad(viewHtml);
  const results = [];

  $("article.card").each((_, el) => {
    const article = $(el);
    // URL from card-body link (canonical form: /allas/{cat}/{slug}/{ID})
    const linkEl = article.find(".card-body a[href*='/allas/']").first();
    const href = linkEl.attr("href");
    if (!href || !/\/allas\/[^/]+\/[^/]+\/\d+/.test(href)) return;

    // Title from h3.card-title inside the link
    const title = normalizeWhitespace(
      article.find(".card-title").first().text()
    );
    if (!title) return;

    results.push({
      url: normalizeUrl(`${BASE}${href}`),
      title,
    });
  });

  return results;
}

/* ── db ──────────────────────────────────────────────────────── */

async function upsertJob(client, source, item) {
  const canonicalUrl = item.url;
  const res = await client.query(
    `INSERT INTO job_posts (source, title, url, canonical_url, experience, first_seen)
     VALUES ($1,$2,$3,$4,$5,NOW())
     ON CONFLICT (source, url) DO NOTHING
     RETURNING id;`,
    [source, item.title, item.url, canonicalUrl, "diákmunka"]
  );
  return res.rowCount > 0;
}

/* ── handler ─────────────────────────────────────────────────── */

export default withTimeout("cron_jobs_PANNONDIAK-background", async () => {
  _filters = await loadFilters();
  const client = await pool.connect();

  let newlyInserted = 0;
  let alreadyExisted = 0;
  let skippedSenior = 0;
  let fetchFailed = 0;
  const seen = new Set();

  try {
    const foundUrls = [];
    for (let page = 1; page <= 10; page++) {
      let result;
      try {
        await sleep(600);
        result = await postSearch(page);
      } catch (err) {
        fetchFailed++;
        await logFetchError("cron_jobs_PANNONDIAK-background", {
          url: `${SEARCH_URL}?page=${page}`,
          message: err.message,
        });
        console.error(`[pannondiak] page ${page} fetch failed: ${err.message}`);
        break;
      }

      const cards = parseCards(result.view ?? "");
      if (cards.length === 0) {
        console.log(`[pannondiak] page ${page} empty, done`);
        break;
      }

      console.log(`[pannondiak] page ${page}: ${cards.length} cards`);

      for (const job of cards) {
        if (seen.has(job.url)) continue;
        seen.add(job.url);

        if (isSeniorLike(job.title)) {
          skippedSenior++;
          console.log(`[pannondiak] SKIP senior "${job.title}"`);
          continue;
        }

        const wasNew = await upsertJob(client, "pannondiak", job);
        foundUrls.push(job.url);
        if (wasNew) {
          newlyInserted++;
          console.log(`[pannondiak] NEW "${job.title}" → ${job.url}`);
        } else {
          alreadyExisted++;
          console.log(`[pannondiak] EXISTS "${job.title}"`);
        }
      }
    }

    console.log(
      `[pannondiak] DONE — new=${newlyInserted}, existed=${alreadyExisted}, ` +
      `skipped_senior=${skippedSenior}, fetch_failed=${fetchFailed}`
    );

    const complete = fetchFailed === 0;
    const rc = await reconcileActive(client, "pannondiak", foundUrls, { complete });
    console.log(`[pannondiak] active reconcile — complete=${complete}, ${JSON.stringify(rc)}`);
  } finally {
    client.release();
  }
});
