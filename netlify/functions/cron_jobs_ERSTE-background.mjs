/*
  Erste Bank karrier oldal scraper
  API: POST https://karrier.erstebank.hu/jsbq (same platform as K&H/Raiffeisen)
  Filter: specialities[]=IT, Biztonságmenedzsment és Digitalizáció & locations[]=Budapest

  Flow:
    1. POST API with pagination
    2. Parse row HTML — list contains experience field directly
    3. Senior: experience contains "5 év fölött" or "vezető" (without junior/medior values)
              OR isSeniorLike(title)
    4. Intern: experience contains "Gyakornok" or "pályakezdő" OR isInternshipTitle(title)
*/

import { Pool } from "pg";
import https from "https";
import http from "http";
import zlib from "zlib";
import { load as cheerioLoad } from "cheerio";
import { loadFilters } from "./load_filters.mjs";
import { logFetchError, withTimeout } from "./_error-logger.mjs";
import { isInternshipTitle } from "./_experience_core.mjs";

let _filters = [];

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

const BASE = "https://karrier.erstebank.hu";
const API = `${BASE}/jsbq`;
// NOTE: Erste uses `locations[]` (not `cities[]` like K&H/Raiffeisen)
const FILTER_Q = "specialities[]=IT, Biztonságmenedzsment és Digitalizáció&locations[]=Budapest&";

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

export default withTimeout("cron_jobs_ERSTE-background", async () => {
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
        await logFetchError("cron_jobs_ERSTE-background", { url: API, message: err.message });
        console.error(`[erste] page ${page} fetch failed: ${err.message}`);
        break;
      }
      total = res.total || 0;
      const rows = Array.isArray(res.rows) ? res.rows : [];
      console.log(`[erste] page ${page}: ${rows.length} jobs (total=${total})`);
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
    console.log(`[erste] total unique rows: ${dedup.length}`);

    let newlyInserted = 0;
    let alreadyExisted = 0;
    let skippedSenior = 0;
    let skippedNoTitle = 0;
    let notBudapest = 0;

    for (const row of dedup) {
      try {
        const $ = cheerioLoad(row.row || "");
        const title = normalizeWhitespace($(".jobList__item__title").first().text());
        const city = normalizeWhitespace($(".job_list_city").first().text());
        const expValues = $(".job_list_experiences")
          .map((_, el) => normalizeWhitespace($(el).text()))
          .get()
          .filter(Boolean);
        const expCombined = expValues.join(" ");
        const url = `${BASE}${row.url}`;

        if (!title) {
          skippedNoTitle++;
          console.log(`[erste] SKIP no-title → ${url}`);
          continue;
        }
        if (city && !city.toLowerCase().includes("budapest")) {
          notBudapest++;
          console.log(`[erste] SKIP not-Budapest "${title}" city="${city}" → ${url}`);
          continue;
        }

        const expLower = expCombined.toLowerCase();
        const hasSeniorMarker = expLower.includes("5 év fölött") || expLower.includes("vezető");
        const hasJuniorMarker =
          expLower.includes("1-3 év") ||
          expLower.includes("3-5 év") ||
          expLower.includes("0-2 év") ||
          expLower.includes("2-5 év");
        const seniorOnly = hasSeniorMarker && !hasJuniorMarker;

        if (seniorOnly || isSeniorLike(title)) {
          skippedSenior++;
          console.log(`[erste] SKIP senior "${title}" exp="${expCombined}" → ${url}`);
          continue;
        }

        const isIntern =
          expLower.includes("gyakornok") ||
          expLower.includes("pályakezdő") ||
          expLower.includes("palyakezdo") ||
          isInternshipTitle(title);

        let source = "erste";
        let experience = isIntern ? "diákmunka" : expCombined || "-";

        const wasNew = await upsertJob(client, source, { title, url, experience });
        if (wasNew) {
          newlyInserted++;
          console.log(`[erste] NEW [${source}] "${title}" exp=${experience} → ${url}`);
        } else {
          alreadyExisted++;
          console.log(`[erste] EXISTS [${source}] "${title}" → ${url}`);
        }
      } catch (err) {
        console.error(`[erste] row parse failed: ${err.message}`);
      }
    }

    console.log(
      `[erste] DONE — total=${dedup.length}, new=${newlyInserted}, existed=${alreadyExisted}, ` +
      `skipped_senior=${skippedSenior}, skipped_no_title=${skippedNoTitle}, not_budapest=${notBudapest}`
    );
  } finally {
    client.release();
  }
});
