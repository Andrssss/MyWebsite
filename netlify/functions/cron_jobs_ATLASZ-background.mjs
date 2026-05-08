/*
  Atlasz Munkák – IT kategória scraper

  List URL:
    https://atlaszmunkak.hu/munkak.php?cat=22&catnev=IT

  Flow:
    1. Fetch list page → extract <a href="/ad.php?id=NNNN"> job links
       Budapest validation done at LIST level: anchor's text content must contain "budapest"
       (no Budapest URL filter exists; non-Budapest jobs e.g. "Budaörs" appear in the list)
    2. Fetch each Budapest detail page
    3. Parse <h1> for job title
    4. extractBodyExperience → experience field
    5. Senior filter via _filters
    6. Upsert to job_posts (source = "atlasz")
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

const BASE = "https://atlaszmunkak.hu";
const LIST_URL = `${BASE}/munkak.php?cat=22&catnev=IT`;

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
    // Strip the cosmetic `pnev` slug parameter — it's display-only
    u.searchParams.delete("pnev");
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
          "User-Agent": "JobWatcher/1.0",
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

// Extract Budapest-only job links. Each kártya is an <a href="/ad.php?id=NNNN">
// whose visible text contains: TITLE | helyszín | kategóriák | óra/hét.
// Non-Budapest links (e.g. "Budaörs") are filtered out here.
function extractJobLinks(html, baseUrl) {
  const $ = cheerioLoad(html);
  const items = [];
  const seen = new Set();

  $("a[href]").each((_, el) => {
    const raw = $(el).attr("href");
    if (!raw) return;
    let path;
    try {
      path = new URL(raw, baseUrl).pathname;
    } catch {
      return;
    }
    if (path !== "/ad.php") return;

    const full = normalizeUrl(new URL(raw, baseUrl).toString());
    if (seen.has(full)) return;

    const linkText = normalizeText($(el).text());
    if (!linkText.includes("budapest")) return; // Budapest-only

    seen.add(full);
    items.push({ url: full, listingText: $(el).text().trim() });
  });

  return items;
}

/* ── detail page parser ──────────────────────────────────────── */

function extractTitle(html) {
  const $ = cheerioLoad(html);
  const h1 = normalizeWhitespace($("h1").first().text());
  if (h1 && h1.length >= 3) return h1;

  const raw = normalizeWhitespace($("title").first().text());
  // strip site suffix
  return raw.replace(/\s*[|·-]\s*Atlasz.*$/i, "").trim();
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

export default withTimeout("cron_jobs_ATLASZ-background", async () => {
  _filters = await loadFilters();
  const client = await pool.connect();

  let listHtml;
  try {
    listHtml = await fetchText(LIST_URL);
  } catch (err) {
    await logFetchError("cron_jobs_ATLASZ-background", { url: LIST_URL, message: err.message });
    console.error(`[atlasz] list fetch failed: ${err.message}`);
    client.release();
    return;
  }

  const items = extractJobLinks(listHtml, BASE);
  console.log(`[atlasz] list: ${items.length} Budapest job links`);

  let newlyInserted = 0;
  let alreadyExisted = 0;
  let skippedSenior = 0;
  let skippedNoTitle = 0;
  let detailFetchFailed = 0;

  try {
    for (const { url: detailUrl, listingText } of items) {
      try {
        await sleep(800);
        const html = await fetchText(detailUrl);
        let title = extractTitle(html);

        // Fallback: derive title from listing anchor text (first chunk before helyszín)
        if (!title && listingText) {
          // Listing format: "TITLE Budapest Kategória 20 óra/hét" – grab tokens up to "Budapest"
          const m = listingText.match(/^(.+?)\s+Budapest/i);
          if (m) title = normalizeWhitespace(m[1]);
        }

        if (!title) {
          skippedNoTitle++;
          console.log(`[atlasz] SKIP no-title → ${detailUrl}`);
          continue;
        }

        if (isSeniorLike(title)) {
          skippedSenior++;
          console.log(`[atlasz] SKIP senior "${title}" → ${detailUrl}`);
          continue;
        }

        const experience = isInternshipTitle(title)
          ? "diákmunka"
          : extractBodyExperience(html) || "-";

        const wasNew = await upsertJob(client, "atlasz", {
          title,
          url: detailUrl,
          experience,
        });

        if (wasNew) {
          newlyInserted++;
          console.log(`[atlasz] NEW "${title}" exp=${experience} → ${detailUrl}`);
        } else {
          alreadyExisted++;
          console.log(`[atlasz] EXISTS "${title}" → ${detailUrl}`);
        }
      } catch (err) {
        detailFetchFailed++;
        await logFetchError("cron_jobs_ATLASZ-background", { url: detailUrl, message: err.message });
        console.error(`[atlasz] detail fetch failed ${detailUrl}: ${err.message}`);
      }
    }

    console.log(
      `[atlasz] DONE — total=${items.length}, new=${newlyInserted}, existed=${alreadyExisted}, ` +
      `skipped_senior=${skippedSenior}, skipped_no_title=${skippedNoTitle}, fetch_failed=${detailFetchFailed}`
    );
  } finally {
    client.release();
  }
});
