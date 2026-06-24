import { Pool } from "pg";
import https from "https";
import http from "http";
import zlib from "zlib";
import { load as cheerioLoad } from "cheerio";
import { loadFilters } from "./load_filters.mjs";
import { logFetchError, flushErrors } from "./_error-logger.mjs";
import { isInternshipTitle, isJuniorTitle, isMidLevelTitle } from "./_experience_core.mjs";

const JOB_NAME = "cron_jobs_F_3-background";
const SOURCE = "workly";
const BASE = "https://workly.hu";
const FILTER_PARAMS = "show_results=1&query=&location=Budapest&primary_expertise%5B%5D=it-digital-technology";

let _filters = [];

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

/* ── helpers ─────────────────────────────────────────────────── */

function normalizeText(s) {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeWhitespace(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
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
  const t = normalizeText(title ?? "");
  return _filters.some((kw) => _blacklistRegex(kw).test(t));
}

function isWorklyJobUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname === "workly.hu" && u.pathname.startsWith("/allas/") && u.pathname.length > "/allas/".length;
  } catch {
    return false;
  }
}

function detectExperience(title, cardText) {
  const c = normalizeText(cardText ?? "");
  if (isInternshipTitle(title) || c.includes("szakmai gyakorlat")) return "diákmunka";
  if (isJuniorTitle(title) || c.includes("junior")) return "junior";
  if (isMidLevelTitle(title) || c.includes("medior")) return "medior";
  return "-";
}

function fetchText(url, redirectLeft = 5) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(
      u,
      {
        method: "GET",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
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
        let data = "";
        stream.setEncoding("utf8");
        stream.on("data", (chunk) => (data += chunk));
        stream.on("end", () => {
          if (code >= 200 && code < 300) resolve(data);
          else reject(new Error(`HTTP ${code} for ${url}`));
        });
        stream.on("error", reject);
      }
    );
    req.on("timeout", () => req.destroy(new Error(`Timeout for ${url}`)));
    req.on("error", reject);
    req.end();
  });
}

/* ── listing page parser ─────────────────────────────────────── */

// Cards have no heading tags — title is the first text block inside <a>,
// followed by location(s) then a work-type keyword (Jelenléti/Hibrid/etc.).
function titleFromCardText(cardText) {
  // Split at first work-type or experience-badge keyword — these come after title+location
  const m = cardText.match(
    /^([\s\S]+?)\s+(?:Jelenléti|Hibrid|Távmunka|Home\s*office|Részmunkaidő|Teljes\s+munkaidő|Junior\s*\(|Medior\s*\(|Senior\s*\(|Szakmai\s+gyakorlat)\b/i
  );
  if (!m) return normalizeWhitespace(cardText).slice(0, 120);

  // m[1] = "Job Title [City, City, ...]" — strip trailing city names (capitalised proper nouns)
  const withoutCities = normalizeWhitespace(m[1])
    .replace(/(?:[,\s]+[A-ZÁÉÍÓÖŐÚÜŰ][a-záéíóöőúüűA-ZÁÉÍÓÖŐÚÜŰ -]+)+\s*$/, "")
    .trim();
  return withoutCities || normalizeWhitespace(m[1]);
}

function extractJobEntries(html) {
  const $ = cheerioLoad(html);
  const entries = [];
  const seen = new Set();

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    let url;
    try {
      url = normalizeUrl(new URL(href, BASE).toString());
    } catch {
      return;
    }
    if (!isWorklyJobUrl(url)) return;
    if (seen.has(url)) return;
    seen.add(url);

    const cardText = normalizeWhitespace($(el).text());
    const title = titleFromCardText(cardText);
    if (!title || title.length < 3) return;

    entries.push({ title, url, cardText });
  });

  return entries;
}

/* ── handler ─────────────────────────────────────────────────── */

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  const expected = process.env.CRON_SECRET;
  if (!expected || token !== expected) {
    return new Response("Unauthorized", { status: 401 });
  }

  let startPage = 1;
  let maxPages = Infinity;
  try {
    const body = await request.json();
    if (typeof body.startPage === "number") startPage = body.startPage;
    if (typeof body.maxPages === "number") maxPages = body.maxPages;
  } catch {
    // no body or invalid JSON — use defaults
  }

  console.log(`[${JOB_NAME}] starting pages ${startPage}–${maxPages === Infinity ? "∞" : startPage + maxPages - 1}`);

  _filters = await loadFilters();
  const client = await pool.connect();

  let newlyInserted = 0;
  let alreadyExisted = 0;
  let skippedSenior = 0;

  try {
    let page = startPage;
    let pagesProcessed = 0;

    while (pagesProcessed < maxPages) {
      const pageUrl = page === 1
        ? `${BASE}/allasok/?${FILTER_PARAMS}`
        : `${BASE}/allasok/page/${page}/?${FILTER_PARAMS}`;

      let html;
      try {
        html = await fetchText(pageUrl);
      } catch (err) {
        if (String(err?.message || "").includes("HTTP 404")) {
          console.log(`[workly] pagination stopped at page ${page} (404)`);
          break;
        }
        await logFetchError(JOB_NAME, { url: pageUrl, message: err.message });
        console.error(`[workly] page ${page} fetch failed: ${err.message}`);
        break;
      }

      const entries = extractJobEntries(html);
      console.log(`[workly] page ${page} → ${entries.length} job links`);

      if (entries.length === 0) {
        console.log(`[workly] page ${page} empty — stopping`);
        break;
      }

      for (const entry of entries) {
        if (isSeniorLike(entry.title)) {
          skippedSenior++;
          console.log(`[workly] SKIP senior "${entry.title}"`);
          continue;
        }

        const experience = detectExperience(entry.title, entry.cardText);
        const res = await client.query(
          `INSERT INTO job_posts (source, title, url, canonical_url, experience, first_seen)
           VALUES ($1,$2,$3,$4,$5,NOW())
           ON CONFLICT (source, url) DO NOTHING
           RETURNING id;`,
          [SOURCE, entry.title, entry.url, entry.url, experience]
        );
        if (res.rowCount > 0) {
          newlyInserted++;
          console.log(`[workly] NEW "${entry.title}" → ${entry.url}`);
        } else {
          alreadyExisted++;
        }
      }

      page++;
      pagesProcessed++;
    }

    console.log(`[workly] DONE — new=${newlyInserted}, existed=${alreadyExisted}, skipped_senior=${skippedSenior}`);
  } finally {
    client.release();
    await flushErrors(JOB_NAME).catch(() => {});
  }

  return new Response("OK");
};
