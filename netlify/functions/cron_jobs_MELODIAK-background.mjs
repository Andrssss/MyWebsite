/*
  MelóDiák – Budapest / informatikai-mernoki-muszaki kategória scraper

  List URL:
    https://www.melodiak.hu/diakmunkak/?ci=budapest&ca=informatikai-mernoki-muszaki

  Flow:
    1. Fetch list page (URL filter ci=budapest & ca=informatikai-mernoki-muszaki)
    2. Try to extract job detail links from <a href>. The exact detail URL pattern
       was not confirmed via DevTools — multiple patterns are probed; if none match,
       falls back to parsing job cards directly from the listing.
    3. For each job:
       - If detail URL exists: fetch detail, parse <h1>, run extractBodyExperience
       - If not: derive title from listing card text, synthesize stable URL
    4. Senior filter via _filters
    5. Upsert to job_posts (source = "melodiak")

  ci=budapest already pre-filters the list to Budapest (incl. district variants
  e.g. "Budapest III. kerület"), so no extra Budapest validation is needed.
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

const BASE = "https://www.melodiak.hu";
const LIST_PATH = "/diakmunkak/?ci=budapest&ca=informatikai-mernoki-muszaki";
const LIST_URL = `${BASE}${LIST_PATH}`;

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

/* ── list page parser ────────────────────────────────────────── */

// Strategy A — try to extract real detail links matching plausible patterns.
function extractDetailLinks(html, baseUrl) {
  const $ = cheerioLoad(html);
  const links = new Set();

  $("a[href]").each((_, el) => {
    const raw = $(el).attr("href");
    if (!raw) return;
    let path;
    try {
      path = new URL(raw, baseUrl).pathname;
    } catch {
      return;
    }
    // Plausible detail URL patterns (one of these should hit when DevTools confirms exact form):
    //   /diakmunkak/{slug}        (single extra segment under /diakmunkak/)
    //   /diakmunka/{slug}         (singular variant)
    //   /munka/{slug}
    //   /jobs/{slug}
    if (
      /^\/diakmunkak\/[^/?#][^/]*\/?$/.test(path) ||
      /^\/diakmunka\/[^/?#][^/]+\/?$/.test(path) ||
      /^\/munka\/[^/?#][^/]+\/?$/.test(path) ||
      /^\/jobs\/[^/?#][^/]+\/?$/.test(path)
    ) {
      // Exclude the listing itself (no extra segment)
      if (path !== "/diakmunkak/" && path !== "/diakmunkak") {
        links.add(normalizeUrl(new URL(raw, baseUrl).toString()));
      }
    }
  });

  return [...links];
}

// Strategy B — parse listing cards directly when no detail URL is available.
// Each job card on the listing displays title + category + city + rate.
// We extract titles by scanning typical card containers.
function extractListingCards(html) {
  const $ = cheerioLoad(html);
  const cards = [];
  const seen = new Set();

  // Heuristic: job cards typically wrapped in elements that contain the
  // word "Érdekel" (the apply button label visible on each kártya).
  const candidates = $('*:contains("Érdekel")').filter((_, el) => {
    // Limit to small-ish containers (a single card, not the page root)
    const text = $(el).text() || "";
    const len = text.length;
    return len > 50 && len < 800;
  });

  candidates.each((_, el) => {
    const text = normalizeWhitespace($(el).text());
    // First line / heading-ish text before category badge "Informatikai, mérnöki, műszaki"
    const m = text.match(/^(.{4,200}?)\s+Informatikai, m[eé]rn[oö]ki, m[uű]szaki/i);
    if (!m) return;
    const title = normalizeWhitespace(m[1]);
    if (!title || seen.has(title)) return;
    seen.add(title);
    cards.push({ title });
  });

  return cards;
}

/* ── detail page parser (Strategy A only) ─────────────────────── */

function extractTitle(html) {
  const $ = cheerioLoad(html);
  const h1 = normalizeWhitespace($("h1").first().text());
  if (h1 && h1.length >= 3) return h1;
  const raw = normalizeWhitespace($("title").first().text());
  return raw.replace(/\s*[|·-]\s*Mel[oó]\s*Di[aá]k.*$/i, "").trim();
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

export default withTimeout("cron_jobs_MELODIAK-background", async () => {
  _filters = await loadFilters();
  const client = await pool.connect();

  let listHtml;
  try {
    listHtml = await fetchText(LIST_URL);
  } catch (err) {
    await logFetchError("cron_jobs_MELODIAK-background", { url: LIST_URL, message: err.message });
    console.error(`[melodiak] list fetch failed: ${err.message}`);
    client.release();
    return;
  }

  // Try Strategy A first — real detail links
  const detailLinks = extractDetailLinks(listHtml, BASE);
  console.log(`[melodiak] detail links found: ${detailLinks.length}`);

  let newlyInserted = 0;
  let alreadyExisted = 0;
  let skippedSenior = 0;
  let skippedNoTitle = 0;
  let detailFetchFailed = 0;

  try {
    if (detailLinks.length > 0) {
      // Strategy A — fetch each detail
      for (const detailUrl of detailLinks) {
        try {
          await sleep(800);
          const html = await fetchText(detailUrl);
          const title = extractTitle(html);

          if (!title) {
            skippedNoTitle++;
            console.log(`[melodiak] SKIP no-title → ${detailUrl}`);
            continue;
          }
          if (isSeniorLike(title)) {
            skippedSenior++;
            console.log(`[melodiak] SKIP senior "${title}" → ${detailUrl}`);
            continue;
          }

          const experience = isInternshipTitle(title)
            ? "diákmunka"
            : extractBodyExperience(html) || "-";

          const wasNew = await upsertJob(client, "melodiak", {
            title,
            url: detailUrl,
            experience,
          });
          if (wasNew) {
            newlyInserted++;
            console.log(`[melodiak] NEW "${title}" exp=${experience} → ${detailUrl}`);
          } else {
            alreadyExisted++;
            console.log(`[melodiak] EXISTS "${title}" → ${detailUrl}`);
          }
        } catch (err) {
          detailFetchFailed++;
          await logFetchError("cron_jobs_MELODIAK-background", { url: detailUrl, message: err.message });
          console.error(`[melodiak] detail fetch failed ${detailUrl}: ${err.message}`);
        }
      }
    } else {
      // Strategy B — fall back to listing card parsing (no detail URL discovered)
      console.warn(
        "[melodiak] no detail URLs detected — falling back to listing card parser. " +
        "Inspect with DevTools to confirm/extend extractDetailLinks() patterns."
      );
      const cards = extractListingCards(listHtml);
      console.log(`[melodiak] listing cards parsed: ${cards.length}`);

      for (const { title } of cards) {
        if (isSeniorLike(title)) {
          skippedSenior++;
          console.log(`[melodiak] SKIP senior "${title}"`);
          continue;
        }

        // Synthesize a stable URL from title slug — anchor on listing URL
        const syntheticUrl = `${LIST_URL}#${slugify(title)}`;
        const experience = isInternshipTitle(title) ? "diákmunka" : "-";

        const wasNew = await upsertJob(client, "melodiak", {
          title,
          url: syntheticUrl,
          experience,
        });
        if (wasNew) {
          newlyInserted++;
          console.log(`[melodiak] NEW (from card) "${title}" → ${syntheticUrl}`);
        } else {
          alreadyExisted++;
          console.log(`[melodiak] EXISTS (from card) "${title}"`);
        }
      }
    }

    console.log(
      `[melodiak] DONE — new=${newlyInserted}, existed=${alreadyExisted}, ` +
      `skipped_senior=${skippedSenior}, skipped_no_title=${skippedNoTitle}, fetch_failed=${detailFetchFailed}`
    );
  } finally {
    client.release();
  }
});
