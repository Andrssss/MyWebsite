/*
  WorkCenter – informatikus kategória scraper

  List URL:
    https://workcenter.hu/jobs/?s=Budapest&filter_job_listing_category=informatikus
    https://workcenter.hu/jobs/page/{N}/?s=Budapest&filter_job_listing_category=informatikus

  WordPress WP Job Manager alapú site.
  Raw HTTP GET-tel teljes HTML visszajön (nem JS-rendered).

  Stratégia: LISTING-ONLY
    - title: h3.job-listing-loop-job__title (listing-ből)
    - location: .job-details-inner .job-location.location (listing-ből)
    - s=Budapest server-side szűr, de location check is megmarad biztonsági hálóként
    - experience: isInternshipTitle(title) — detail oldalon nincs strukturált tapasztalat mező
    - url = az anchor href (/munka/{slug}/)

  Flow:
    1. Fetch listing pages page=1,2,... — stop ha nincs li.job_listing
    2. li.job_listing → title + location parse cheerio-val
    3. Budapest check location-ből
    4. isSeniorLike filter
    5. Upsert (source = "workcenter")
*/

import { Pool } from "pg";
import https from "https";
import http from "http";
import zlib from "zlib";
import { load as cheerioLoad } from "cheerio";
import { loadFilters } from "./load_filters.mjs";
import { logFetchError, withTimeout } from "./_error-logger.mjs";
import { isInternshipTitle, extractYearsFromText } from "./_experience_core.mjs";

let _filters = [];

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

const BASE = "https://workcenter.hu";
const LIST_BASE = `${BASE}/jobs`;
const CATEGORY_PARAM = "s=Budapest&filter_job_listing_category=informatikus";

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

/* ── experience from detail page ─────────────────────────────── */

const INTERN_TEXT_KEYWORDS = [
  "gyakornok", "intern", "internship", "trainee",
  "pályakezdő", "palyakezdo", "diákmunka", "diakmunka",
  "tehetségprogram", "tehetsegprogram",
  "friss diplomás", "friss diplomas",
  "nem szükséges tapasztalat", "tapasztalat nem szükséges",
  "tapasztalat nélkül", "tapasztalat nelkul",
  "belépő szintű", "belepo szintu",
];

function detectExperienceFromText(title, descText) {
  const t = normalizeText(title);
  const d = normalizeText(descText ?? "");
  const combined = t + " " + d;

  // 1. Internship/entry markers take priority
  if (INTERN_TEXT_KEYWORDS.some(k => combined.includes(normalizeText(k)))) return "diákmunka";

  // 2. Extract year-based experience from description
  const years = extractYearsFromText(descText ?? "");
  if (years) return years;

  return "-";
}

async function fetchDetailExperience(url, title) {
  // 1. Title is enough — skip detail fetch
  if (isInternshipTitle(title)) return "diákmunka";
  // 2. Title inconclusive — check description text
  try {
    const html = await fetchText(url);
    const $ = cheerioLoad(html);
    const descText = $(".single-job-listing__description").first().text();
    return detectExperienceFromText(title, descText);
  } catch {
    return "-";
  }
}

/* ── list page parser ────────────────────────────────────────── */

function extractJobEntries(html) {
  const $ = cheerioLoad(html);
  const entries = [];

  // WP Job Manager structure: ul.job_listings > li.job_listing > a[href*="/munka/"]
  // Title:    h3.job-listing-loop-job__title  (inside the anchor)
  // Location: .job-location.location (first one, inside .job-details-inner)
  $("li.job_listing").each((_, li) => {
    const anchor = $(li).find("a[href*='/munka/'], a[href*='post_type=job_listing']").first();
    if (!anchor.length) return;

    const href = anchor.attr("href") ?? "";
    const title = normalizeWhitespace($(li).find("h3.job-listing-loop-job__title").first().text());
    if (!title || title.length < 2) return;

    // Location: prefer the one inside job-details-inner (not meta duplicate)
    const location = normalizeWhitespace(
      $(li).find(".job-details-inner .job-location.location").first().text()
        .replace(/^[\s\S]*?(?=[A-Za-záéíóöőúüűÁÉÍÓÖŐÚÜŰ])/, "") // strip icon text
    );

    if (!location.toLowerCase().includes("budapest")) return;

    const url = normalizeUrl(new URL(href, BASE).toString());
    entries.push({ title, url });
  });

  return entries;
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

export default withTimeout("cron_jobs_WORKCENTER-background", async () => {
  _filters = await loadFilters();
  const client = await pool.connect();

  let newlyInserted = 0;
  let alreadyExisted = 0;
  let skippedSenior = 0;
  let fetchFailed = 0;

  try {
    let page = 1;
    const MAX_PAGES = 10;

    while (page <= MAX_PAGES) {
      const listUrl =
        page === 1
          ? `${LIST_BASE}/?${CATEGORY_PARAM}`
          : `${LIST_BASE}/page/${page}/?${CATEGORY_PARAM}`;

      let listHtml;
      try {
        await sleep(800);
        listHtml = await fetchText(listUrl);
      } catch (err) {
        fetchFailed++;
        await logFetchError("cron_jobs_WORKCENTER-background", { url: listUrl, message: err.message });
        console.error(`[workcenter] list page ${page} fetch failed: ${err.message}`);
        break;
      }

      const entries = extractJobEntries(listHtml);
      console.log(`[workcenter] page ${page} → ${entries.length} Budapest IT jobs`);

      if (entries.length === 0) {
        // Could be empty page or no more pages
        if (page === 1) {
          console.warn("[workcenter] page 1 returned 0 entries — check selector");
        }
        break;
      }

      for (const entry of entries) {
        if (isSeniorLike(entry.title)) {
          skippedSenior++;
          console.log(`[workcenter] SKIP senior "${entry.title}"`);
          continue;
        }

        const experience = await fetchDetailExperience(entry.url, entry.title);

        const wasNew = await upsertJob(client, "workcenter", {
          title: entry.title,
          url: entry.url,
          experience,
        });
        if (wasNew) {
          newlyInserted++;
          console.log(`[workcenter] NEW "${entry.title}" → ${entry.url}`);
        } else {
          alreadyExisted++;
          console.log(`[workcenter] EXISTS "${entry.title}"`);
        }
      }

      page++;
    }

    console.log(
      `[workcenter] DONE — new=${newlyInserted}, existed=${alreadyExisted}, ` +
      `skipped_senior=${skippedSenior}, fetch_failed=${fetchFailed}`
    );
  } finally {
    client.release();
  }
});
