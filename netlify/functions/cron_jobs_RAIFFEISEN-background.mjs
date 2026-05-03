/*
  Raiffeisen Bank karrier oldal scraper
  API: POST https://raiffeisen.karrierportal.hu/jsbq (same platform as K&H)
  Filter: specialities[]=IT / Projektvezetés / Szervezés
        + specialities[]=Bankbiztonság
        + cities[]=Budapest

  Flow:
    1. POST API with pagination
    2. Parse row HTML (CSS classes, not data-cy)
    3. Senior filter: level "Szenior" OR isSeniorLike(title)
    4. Intern: level "Gyakornok" OR isInternshipTitle(title)
*/

import { Pool } from "pg";
import https from "https";
import http from "http";
import zlib from "zlib";
import { load as cheerioLoad } from "cheerio";
import { loadFilters } from "./load_filters.mjs";
import { logFetchError, withTimeout } from "./_error-logger.mjs";
import { extractBodyExperience, isInternshipTitle } from "./_experience_core.mjs";

let _filters = [];

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

const BASE = "https://raiffeisen.karrierportal.hu";
const API = `${BASE}/jsbq`;
const FILTER_Q =
  "specialities[]=IT / Projektvezetés / Szervezés" +
  "&specialities[]=Bankbiztonság" +
  "&cities[]=Budapest&";

/* ── helpers ─────────────────────────────────────────────────── */

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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function fetchText(url, redirectLeft = 5) {
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
        let body = "";
        stream.setEncoding("utf8");
        stream.on("data", (c) => (body += c));
        stream.on("end", () =>
          code >= 200 && code < 300 ? resolve(body) : reject(new Error(`HTTP ${code} for ${url}`))
        );
        stream.on("error", reject);
      }
    );
    req.on("timeout", () => req.destroy(new Error(`Timeout for ${url}`)));
    req.on("error", reject);
    req.end();
  });
}

function _blacklistRegex(k) {
  const escaped = normalizeText(k).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i");
}

function isSeniorLike(title) {
  const n = normalizeText(title ?? "");
  return _filters.some((kw) => _blacklistRegex(kw).test(n));
}

function postForm(url, body) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const lib = parsedUrl.protocol === "https:" ? https : http;
    const req = lib.request(
      parsedUrl,
      {
        method: "POST",
        headers: {
          "User-Agent": "JobWatcher/1.0",
          Accept: "application/json, text/javascript, */*",
          "Accept-Language": "hu-HU,hu;q=0.9,en;q=0.8",
          "Accept-Encoding": "gzip,deflate,br",
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
          Referer: `${BASE}/allasok`,
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
          code >= 200 && code < 300 ? resolve(buf) : reject(new Error(`HTTP ${code} for ${url}`))
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

async function fetchPage(page) {
  const body = `sRoute=public_job_esearch&q=${encodeURIComponent(FILTER_Q)}&page=${page}`;
  const text = await postForm(API, body);
  return JSON.parse(text);
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

export default withTimeout("cron_jobs_RAIFFEISEN-background", async () => {
  _filters = await loadFilters();
  const client = await pool.connect();
  try {
    const allRows = [];
    let page = 0;
    let total = 0;

    do {
      let res;
      try {
        res = await fetchPage(page);
      } catch (err) {
        await logFetchError("cron_jobs_RAIFFEISEN-background", { url: API, message: err.message });
        console.error(`[raiffeisen] page ${page} fetch failed: ${err.message}`);
        break;
      }
      total = res.total || 0;
      const rows = Array.isArray(res.rows) ? res.rows : [];
      console.log(`[raiffeisen] page ${page}: ${rows.length} jobs (total=${total})`);
      allRows.push(...rows);
      if (rows.length === 0) break;
      page++;
    } while (allRows.length < total);

    const seen = new Set();
    const dedup = [];
    for (const r of allRows) {
      if (!r.url || seen.has(r.url)) continue;
      seen.add(r.url);
      dedup.push(r);
    }
    console.log(`[raiffeisen] total unique rows: ${dedup.length}`);

    let newlyInserted = 0;
    let alreadyExisted = 0;
    let skippedSenior = 0;
    let skippedNoTitle = 0;
    let notBudapest = 0;
    let detailFetchFailed = 0;

    for (const row of dedup) {
      try {
        const $ = cheerioLoad(row.row || "");
        const title = normalizeWhitespace($(".jobList__item__title a").first().text());
        const level = normalizeWhitespace($(".job_list_level").first().text());
        const city = normalizeWhitespace($(".job_list_city").first().text());
        const url = `${BASE}${row.url}`;

        if (!title) {
          skippedNoTitle++;
          console.log(`[raiffeisen] SKIP no-title → ${url}`);
          continue;
        }
        if (city && !city.toLowerCase().includes("budapest")) {
          notBudapest++;
          console.log(`[raiffeisen] SKIP not-Budapest "${title}" city="${city}" → ${url}`);
          continue;
        }

        const levelLower = level.toLowerCase();
        if (levelLower.includes("szenior") || isSeniorLike(title)) {
          skippedSenior++;
          console.log(`[raiffeisen] SKIP senior "${title}" level="${level}" → ${url}`);
          continue;
        }

        let source = "raiffeisen";
        let experience;
        if (levelLower.includes("gyakornok") || isInternshipTitle(title)) {
          experience = "diákmunka";
        } else {
          await sleep(800);
          let detailHtml;
          try {
            detailHtml = await fetchText(url);
          } catch (err) {
            detailFetchFailed++;
            await logFetchError("cron_jobs_RAIFFEISEN-background", { url, message: err.message });
            console.error(`[raiffeisen] detail fetch failed ${url}: ${err.message}`);
            continue;
          }
          experience = extractBodyExperience(detailHtml) || "-";
        }

        const wasNew = await upsertJob(client, source, { title, url, experience });
        if (wasNew) {
          newlyInserted++;
          console.log(`[raiffeisen] NEW [${source}] "${title}" exp=${experience} → ${url}`);
        } else {
          alreadyExisted++;
          console.log(`[raiffeisen] EXISTS [${source}] "${title}" → ${url}`);
        }
      } catch (err) {
        console.error(`[raiffeisen] row parse failed: ${err.message}`);
      }
    }

    console.log(
      `[raiffeisen] DONE — total=${dedup.length}, new=${newlyInserted}, existed=${alreadyExisted}, ` +
      `skipped_senior=${skippedSenior}, skipped_no_title=${skippedNoTitle}, not_budapest=${notBudapest}, ` +
      `fetch_failed=${detailFetchFailed}`
    );
  } finally {
    client.release();
  }
});
