/*
  K&H Bank karrier oldal scraper
  API: POST https://karrier.kh.hu/jsbq
       sRoute=public_job_esearch&q=<urlencoded filter>&page=N
  Filter: specialities[]=IT és innováció & cities[]=Budapest

  Flow:
    1. POST API with pagination (rowNum=20 per page)
    2. Parse each row.row HTML with cheerio
    3. Intern detection (level "szakmai gyakorlat" OR title keywords)
    4. Direct experience field upsert (no detail fetch, no senior filter)
*/

import { Pool } from "pg";
import https from "https";
import http from "http";
import zlib from "zlib";
import { load as cheerioLoad } from "cheerio";
import { logFetchError, withTimeout } from "./_error-logger.mjs";
import { isInternshipTitle } from "./_experience_core.mjs";

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

const BASE = "https://karrier.kh.hu";
const API = `${BASE}/jsbq`;
const FILTER_Q = "specialities[]=IT és innováció&cities[]=Budapest&";

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

export default withTimeout("cron_jobs_KH-background", async () => {
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
        await logFetchError("cron_jobs_KH-background", { url: API, message: err.message });
        console.error(`[kh] page ${page} fetch failed: ${err.message}`);
        break;
      }
      total = res.total || 0;
      const rows = Array.isArray(res.rows) ? res.rows : [];
      console.log(`[kh] page ${page}: ${rows.length} jobs (total=${total})`);
      allRows.push(...rows);
      if (rows.length === 0) break;
      page++;
    } while (allRows.length < total);

    // Dedup by URL
    const seen = new Set();
    const dedup = [];
    for (const r of allRows) {
      if (!r.url || seen.has(r.url)) continue;
      seen.add(r.url);
      dedup.push(r);
    }
    console.log(`[kh] total unique rows: ${dedup.length}`);

    let newlyInserted = 0;
    let alreadyExisted = 0;
    let skippedNoTitle = 0;

    for (const row of dedup) {
      try {
        const $ = cheerioLoad(row.row || "");
        const title = normalizeWhitespace($('[data-cy="job_title"]').first().text());
        const expRaw = normalizeWhitespace($('[data-cy="experiences"]').first().text());
        const url = `${BASE}${row.url}`;

        if (!title) {
          skippedNoTitle++;
          console.log(`[kh] SKIP no-title → ${url}`);
          continue;
        }

        const expLower = expRaw.toLowerCase();
        let source = "kh";
        let experience = expRaw || "-";

        if (expLower === "szakmai gyakorlat" || isInternshipTitle(title)) {
          source = "kh-intern";
          experience = "diákmunka";
        }

        const wasNew = await upsertJob(client, source, { title, url, experience });
        if (wasNew) {
          newlyInserted++;
          console.log(`[kh] NEW [${source}] "${title}" exp=${experience} → ${url}`);
        } else {
          alreadyExisted++;
          console.log(`[kh] EXISTS [${source}] "${title}" → ${url}`);
        }
      } catch (err) {
        console.error(`[kh] row parse failed: ${err.message}`);
      }
    }

    console.log(
      `[kh] DONE — total=${dedup.length}, new=${newlyInserted}, existed=${alreadyExisted}, ` +
      `skipped_no_title=${skippedNoTitle}`
    );
  } finally {
    client.release();
  }
});
