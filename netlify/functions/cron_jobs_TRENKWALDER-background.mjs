/*
  Trenkwalder HU – Budapest / IT-Szoftverfejlesztés scraper

  List URL:
    https://hu.trenkwalder.com/jobs?aroundLoc=Budapest&refinements[jobObject.jobCategory.national][0]=IT/Szoftverfejlesztés

  Flow:
    1. Fetch list pages (page=1,2,...) — stop when no job links found
    2. Extract detail links: /jobs/{18-char-salesforce-id}
    3. Fetch each detail → parse <h1> title
    4. Budapest filter: aroundLoc=Budapest szerver-szűr, list-szintű elég
    5. extractBodyExperience, isInternshipTitle
    6. isSeniorLike filter
    7. Upsert (source = "trenkwalder")
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

const BASE = "https://hu.trenkwalder.com";
const LIST_BASE =
  `${BASE}/jobs?aroundLoc=Budapest` +
  `&refinements%5BjobObject.jobCategory.national%5D%5B0%5D=IT%2FSzoftverfejleszt%C3%A9s`;

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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function _blacklistRegex(k) {
  const escaped = normalizeText(k).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i");
}

function isSeniorLike(title) {
  const n = normalizeText(title ?? "");
  return _filters.some((kw) => _blacklistRegex(kw).test(n));
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
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
          Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
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
          code >= 200 && code < 300
            ? resolve(body)
            : reject(new Error(`HTTP ${code} for ${url}`))
        );
        stream.on("error", reject);
      }
    );

    req.on("timeout", () => req.destroy(new Error(`Timeout for ${url}`)));
    req.on("error", reject);
    req.end();
  });
}

/* ── list page parser ────────────────────────────────────────── */

// Detail links: /jobs/{18-char-id}  (Salesforce ID format)
const DETAIL_RE = /^\/jobs\/[a-zA-Z0-9]{15,18}\/?$/;

function extractDetailLinks(html) {
  const $ = cheerioLoad(html);
  const links = new Set();

  $("a[href]").each((_, el) => {
    const raw = $(el).attr("href");
    if (!raw) return;
    let path;
    try {
      path = new URL(raw, BASE).pathname;
    } catch {
      return;
    }
    if (DETAIL_RE.test(path)) {
      links.add(normalizeUrl(new URL(raw, BASE).toString()));
    }
  });

  return [...links];
}

/* ── detail page parser ──────────────────────────────────────── */

function extractTitle(html) {
  const $ = cheerioLoad(html);
  const h1 = normalizeWhitespace($("h1").first().text());
  if (h1 && h1.length >= 3) return h1;
  const raw = normalizeWhitespace($("title").first().text());
  return raw.replace(/\s*[|·-]\s*Trenkwalder.*$/i, "").trim();
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
  let skippedNoTitle = 0;
  let detailFetchFailed = 0;

  try {
    // Collect all detail links across pages
    const allLinks = new Set();
    let page = 1;

    while (true) {
      const listUrl = `${LIST_BASE}&page=${page}`;
      let listHtml;
      try {
        await sleep(800);
        listHtml = await fetchText(listUrl);
      } catch (err) {
        await logFetchError("cron_jobs_TRENKWALDER-background", { url: listUrl, message: err.message });
        console.error(`[trenkwalder] list page ${page} fetch failed: ${err.message}`);
        break;
      }

      const links = extractDetailLinks(listHtml);
      console.log(`[trenkwalder] page ${page} → ${links.length} links`);
      if (links.length === 0) break;

      links.forEach((l) => allLinks.add(l));
      page++;
    }

    console.log(`[trenkwalder] total unique detail links: ${allLinks.size}`);

    for (const detailUrl of allLinks) {
      try {
        await sleep(800);
        const html = await fetchText(detailUrl);
        const title = extractTitle(html);

        if (!title) {
          skippedNoTitle++;
          console.log(`[trenkwalder] SKIP no-title → ${detailUrl}`);
          continue;
        }
        if (isSeniorLike(title)) {
          skippedSenior++;
          console.log(`[trenkwalder] SKIP senior "${title}"`);
          continue;
        }

        const experience = isInternshipTitle(title)
          ? "diákmunka"
          : extractBodyExperience(html) || "-";

        const wasNew = await upsertJob(client, "trenkwalder", {
          title,
          url: detailUrl,
          experience,
        });
        if (wasNew) {
          newlyInserted++;
          console.log(`[trenkwalder] NEW "${title}" exp=${experience} → ${detailUrl}`);
        } else {
          alreadyExisted++;
          console.log(`[trenkwalder] EXISTS "${title}"`);
        }
      } catch (err) {
        detailFetchFailed++;
        await logFetchError("cron_jobs_TRENKWALDER-background", { url: detailUrl, message: err.message });
        console.error(`[trenkwalder] detail fetch failed ${detailUrl}: ${err.message}`);
      }
    }

    console.log(
      `[trenkwalder] DONE — new=${newlyInserted}, existed=${alreadyExisted}, ` +
      `skipped_senior=${skippedSenior}, skipped_no_title=${skippedNoTitle}, fetch_failed=${detailFetchFailed}`
    );
  } finally {
    client.release();
  }
});
