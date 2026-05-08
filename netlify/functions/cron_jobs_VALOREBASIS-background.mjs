/*
  Valore Basis – IT fejvadász scraper

  Entry point: https://valorebasis.hu/allasok/
  Az oldal flip-kártyákat tartalmaz, minden kártya hátoldalán
  "kattints a részletekért !" link mutat a kategória oldalra.

  Flow:
    1. Fetch /allasok/ → kategória URL-ek dinamikus kinyerése
    2. Minden kategória URL fetch
    3. h5 elemekből title + státusz parse
    4. Státusz "szünetel" → skip
    5. Munkavégzés helye → Budapest check
    6. extractBodyExperience az inline szövegből
    7. Senior filter via _filters
    8. Upsert (source = "valorebasis", url = kategória URL + "#" + slugify(title))
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

const BASE = "https://valorebasis.hu";
const INDEX_URL = `${BASE}/allasok/`;

// Exclude these paths from category link discovery
const EXCLUDED_PATHS = new Set(["/", "/cegeknek/", "/cegeknek", "/allasok", "/allasok/"]);

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

function slugify(s) {
  return normalizeText(s)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
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

/* ── index page: discover category URLs ──────────────────────── */

function extractCategoryUrls(html) {
  const $ = cheerioLoad(html);
  const urls = new Set();

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    let parsed;
    try {
      parsed = new URL(href, BASE);
    } catch {
      return;
    }
    // Only same-origin, non-excluded paths
    if (parsed.hostname !== "valorebasis.hu") return;
    const path = parsed.pathname.replace(/\/$/, "") || "/";
    if (EXCLUDED_PATHS.has(path) || EXCLUDED_PATHS.has(path + "/")) return;
    // Must look like a content slug (not a file)
    if (path.includes(".")) return;
    urls.add(normalizeUrl(parsed.toString()));
  });

  return [...urls];
}

/* ── category page parser ────────────────────────────────────── */

function extractJobs(html, categoryUrl) {
  const $ = cheerioLoad(html);
  const jobs = [];

  // h5 elemek alternálva: cím, státusz, leírás...
  // "PHP FEJLESZTŐ" → h5 cím
  // "Jelentkezési határidő: ..." → h5 státusz
  // A kettő mindig egymás után jelenik meg
  const h5els = $("h5").toArray();

  for (let i = 0; i < h5els.length; i++) {
    const titleText = normalizeWhitespace($(h5els[i]).text());
    // h5 státusz elem a következő h5, tartalmaz "Jelentkezési határidő"
    const statusEl = h5els[i + 1];
    if (!statusEl) continue;

    const statusText = normalizeWhitespace($(statusEl).text());
    if (!statusText.toLowerCase().includes("jelentkezési határidő")) continue;

    // Skip ha szünetel
    if (statusText.toLowerCase().includes("szünetel")) {
      console.log(`[valorebasis] SKIP inactive "${titleText}"`);
      i++; // ugorjuk a státusz h5-öt is
      continue;
    }

    // Budapest validáció — szövegtörzsben keresünk a cím h5 után
    // Kinyerjük a h5 utáni szövegből a "Munkavégzés helye" blokkot
    const nextSection = $(h5els[i]).nextUntil("h5").text();
    const locMatch = nextSection.match(/Munkavégzés helye[:\s]*([^\n•◦]+)/i);
    if (locMatch) {
      const loc = normalizeText(locMatch[1]);
      if (!loc.includes("budapest")) {
        console.log(`[valorebasis] SKIP non-Budapest "${titleText}" loc="${locMatch[1].trim()}"`);
        i++;
        continue;
      }
    }
    // Ha nincs Munkavégzés helye mező → elfogadjuk (site eleve Budapest-fókuszú)

    const experience = isInternshipTitle(titleText)
      ? "diákmunka"
      : extractBodyExperience(nextSection) || "-";

    const syntheticUrl = normalizeUrl(categoryUrl) + "#" + slugify(titleText);

    jobs.push({ title: titleText, url: syntheticUrl, experience });
    i++; // ugorjuk a státusz h5-öt
  }

  return jobs;
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

export default withTimeout("cron_jobs_VALOREBASIS-background", async () => {
  _filters = await loadFilters();
  const client = await pool.connect();

  let newlyInserted = 0;
  let alreadyExisted = 0;
  let skippedSenior = 0;
  let fetchFailed = 0;

  try {
    // Step 1: discover category URLs from index page
    let categoryUrls;
    try {
      const indexHtml = await fetchText(INDEX_URL);
      categoryUrls = extractCategoryUrls(indexHtml);
      console.log(`[valorebasis] discovered ${categoryUrls.length} category URLs`);
    } catch (err) {
      await logFetchError("cron_jobs_VALOREBASIS-background", { url: INDEX_URL, message: err.message });
      console.error(`[valorebasis] index fetch failed: ${err.message}`);
      client.release();
      return;
    }

    for (const catUrl of categoryUrls) {
      let html;
      try {
        await sleep(1000);
        html = await fetchText(catUrl);
      } catch (err) {
        fetchFailed++;
        await logFetchError("cron_jobs_VALOREBASIS-background", { url: catUrl, message: err.message });
        console.error(`[valorebasis] fetch failed ${catUrl}: ${err.message}`);
        continue;
      }

      const jobs = extractJobs(html, catUrl);
      console.log(`[valorebasis] ${catUrl.split("/").pop()} → ${jobs.length} active jobs`);

      for (const job of jobs) {
        if (isSeniorLike(job.title)) {
          skippedSenior++;
          console.log(`[valorebasis] SKIP senior "${job.title}"`);
          continue;
        }

        const wasNew = await upsertJob(client, "valorebasis", job);
        if (wasNew) {
          newlyInserted++;
          console.log(`[valorebasis] NEW "${job.title}" exp=${job.experience} → ${job.url}`);
        } else {
          alreadyExisted++;
          console.log(`[valorebasis] EXISTS "${job.title}"`);
        }
      }
    }

    console.log(
      `[valorebasis] DONE — new=${newlyInserted}, existed=${alreadyExisted}, ` +
      `skipped_senior=${skippedSenior}, fetch_failed=${fetchFailed}`
    );
  } finally {
    client.release();
  }
});
