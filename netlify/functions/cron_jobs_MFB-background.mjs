/*
  MFB Bank karrier oldal scraper
  Platform: HRmaster AngularJS SPA — uses POST JSON API (NOT static HTML)
  API: POST https://karrier.mfb.hu/Datacenter/Registration/GetPositionsBySearchDto
       Body: JSON with positionGroupIdList: [48, 47] (IT depts)
       Response: HTML fragment (not JSON), all jobs in one call

  Flow:
    1. POST API once
    2. Parse HTML fragment with cheerio
    3. Skip if location not Budapest
    4. Skip if level "Szenior" OR isSeniorLike(title)
    5. Intern: level "Gyakornok" OR isInternshipTitle(title) → exp="diákmunka"
    6. Otherwise extract year-range from level (e.g. "Medior (2-5 év)" → "2-5 év")
*/

import { Pool } from "pg";
import https from "https";
import http from "http";
import zlib from "zlib";
import { load as cheerioLoad } from "cheerio";
import { loadFilters } from "./load_filters.mjs";
import { logFetchError, withTimeout } from "./_error-logger.mjs";
import { reconcileActive } from "./_active_core.mjs";
import { isInternshipTitle } from "./_experience_core.mjs";

let _filters = [];

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

const BASE = "https://karrier.mfb.hu";
const API = `${BASE}/Datacenter/Registration/GetPositionsBySearchDto`;
const REFERER = `${BASE}/DataCenter/Registration/JobAdvertisements/allasok`;

const REQUEST_BODY = JSON.stringify({
  searchDto: {
    searchText: "",
    careerLevelTypeIdList: [],
    locationOfWorkTypeIdList: [],
    styleOfWorkTypeIdList: [],
    positionGroupIdList: [48, 47],
    qualificationTypeIdList: [],
    corporationIdList: [],
    categoryTypeIdList: [],
    languageWithLevelIdList: [],
    isLanguageConnectionAnd: null,
    positionGroupId: null,
  },
});

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

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const lib = parsedUrl.protocol === "https:" ? https : http;
    const req = lib.request(
      parsedUrl,
      {
        method: "POST",
        headers: {
          "User-Agent": "JobWatcher/1.0",
          Accept: "*/*",
          "Accept-Language": "hu-HU,hu;q=0.9,en;q=0.8",
          "Accept-Encoding": "gzip,deflate,br",
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": Buffer.byteLength(body),
          Referer: REFERER,
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

export default withTimeout("cron_jobs_MFB-background", async () => {
  _filters = await loadFilters();
  const client = await pool.connect();
  try {
    const foundUrls = [];
    let html;
    try {
      html = await postJson(API, REQUEST_BODY);
    } catch (err) {
      await logFetchError("cron_jobs_MFB-background", { url: API, message: err.message });
      console.error(`[mfb] api fetch failed: ${err.message}`);
      return;
    }

    const $ = cheerioLoad(html);
    const rows = $("[data-position-url]").toArray();
    console.log(`[mfb] list: ${rows.length} jobs found`);

    let newlyInserted = 0;
    let alreadyExisted = 0;
    let skippedSenior = 0;
    let skippedNoTitle = 0;
    let notBudapest = 0;

    for (const el of rows) {
      try {
        const $row = $(el);
        const url = normalizeWhitespace($row.attr("data-position-url"));
        const title = normalizeWhitespace(
          $row.find('[data-e2e-testing="Recruitment.Registration.PositionRepeater.Name"] div').text()
        );
        const careerLevel = normalizeWhitespace(
          $row.find('[data-e2e-testing="Recruitment.Registration.PositionRepeater.CareerLevel"]').text()
        );
        const location = normalizeWhitespace(
          $row.find('[data-e2e-testing="Recruitment.Registration.PositionRepeater.LocationOfWork"]').first().text()
        );

        if (!title) {
          skippedNoTitle++;
          console.log(`[mfb] SKIP no-title → ${url}`);
          continue;
        }
        if (location && !location.toLowerCase().includes("budapest")) {
          notBudapest++;
          console.log(`[mfb] SKIP not-Budapest "${title}" loc="${location}" → ${url}`);
          continue;
        }

        const levelLower = careerLevel.toLowerCase();
        if (levelLower.includes("szenior") || isSeniorLike(title)) {
          skippedSenior++;
          console.log(`[mfb] SKIP senior "${title}" level="${careerLevel}" → ${url}`);
          continue;
        }

        let source = "mfb";
        let experience;
        if (levelLower.includes("gyakornok") || isInternshipTitle(title)) {
          experience = "diákmunka";
        } else {
          // extract year range like "(2-5 év)" → "2-5 év"
          const m = careerLevel.match(/\(([^)]+)\)/);
          experience = m ? m[1].trim() : (careerLevel || "-");
        }

        const wasNew = await upsertJob(client, source, { title, url, experience });
        foundUrls.push(url);
        if (wasNew) {
          newlyInserted++;
          console.log(`[mfb] NEW [${source}] "${title}" exp=${experience} → ${url}`);
        } else {
          alreadyExisted++;
          console.log(`[mfb] EXISTS [${source}] "${title}" → ${url}`);
        }
      } catch (err) {
        console.error(`[mfb] row parse failed: ${err.message}`);
      }
    }

    console.log(
      `[mfb] DONE — total=${rows.length}, new=${newlyInserted}, existed=${alreadyExisted}, ` +
      `skipped_senior=${skippedSenior}, skipped_no_title=${skippedNoTitle}, not_budapest=${notBudapest}`
    );

    // Single API response = full current listing, so the crawl is complete.
    const rc = await reconcileActive(client, "mfb", foundUrls, { complete: true });
    console.log(`[mfb] active reconcile — ${JSON.stringify(rc)}`);
  } finally {
    client.release();
  }
});
