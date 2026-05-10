import { Pool } from "pg";
import https from "https";
import http from "http";
import zlib from "zlib";
import { load as cheerioLoad } from "cheerio";
import { loadFilters } from "./load_filters.mjs";
import { logFetchError } from "./_error-logger.mjs";
import { flagCrossDuplicates } from "./_cross_duplicate.mjs";
import { INTERNSHIP_KEYWORDS, isInternshipTitle } from "./_experience_core.mjs";

let _filters = [];
const ENABLE_FETCH_ERROR_LOGGING = true;

// =====================
// DB
// =====================
const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

// =====================
// HELPERS
// =====================
function normalizeText(s) {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function hasLatinScript(title, minLetters = 2) {
  return (normalizeText(title).match(/[a-z]/g) || []).length >= minLetters;
}

// INTERNSHIP_KEYWORDS / isInternshipTitle imported from _experience_core.mjs

function _blacklistRegex(k) {
  const escaped = normalizeText(k).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i");
}

function titleNotBlacklisted(title) {
  const t = normalizeText(title);
  return !_filters.some(word => _blacklistRegex(word).test(t));
}

function dedupeByUrl(items) {
  const seen = new Set();
  return items.filter((x) => {
    if (!x.url) return false;
    const key = getDedupeKey(x.url);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function randomDelay(minMs = 600, maxMs = 1400) {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise(resolve => setTimeout(resolve, ms));
}

// LinkedIn guest pagination endpoint (returns HTML fragment with the same
// `ul.jobs-search__results-list li` structure as the public search page).
const LINKEDIN_GUEST_PAGINATION_URL =
  "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search";
const LINKEDIN_PAGE_SIZE = 25;

// =====================
// Bot-evasion helpers
// =====================
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0",
];

function pickUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// Custom error class so processLinkedInSources can detect a hard ban
// and abort the entire cron run instead of hammering further.
class LinkedInBlockedError extends Error {
  constructor(status, url) {
    super(`LinkedIn blocked request (HTTP ${status}) for ${url}`);
    this.name = "LinkedInBlockedError";
    this.status = status;
  }
}

// =====================
// URL helpers
// =====================
function normalizeUrl(raw) {
  try {
    const u = new URL(raw);

    if (u.hostname.includes("linkedin.com") && u.pathname.startsWith("/jobs/view/")) {
      return `https://${u.hostname}${u.pathname}`;
    }

    u.hash = "";
    [
      "utm_source","utm_medium","utm_campaign","utm_term",
      "utm_content","fbclid","gclid","trackingId","pageNum","position","refId"
    ].forEach(p => u.searchParams.delete(p));

    return u.toString().replace(/\?$/, "");
  } catch {
    return raw;
  }
}

// =====================
// Fetch helper
// =====================
function fetchText(url, opts = {}, redirectLeft = 5) {
  // opts: { userAgent, referer } — kept for signature compatibility, ignored
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;

    const req = lib.request(
      u,
      {
        method: "GET",
        headers: {
          "User-Agent": "JobWatcher/1.0",
          Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
          "Accept-Language": "hu-HU,hu;q=0.9,en;q=0.8",
          "Accept-Encoding": "gzip,deflate,br",
        },
        timeout: 25000,
      },
      (res) => {
        const code = res.statusCode || 0;

        if ([301,302,303,307,308].includes(code)) {
          const loc = res.headers.location;
          if (!loc) return reject(new Error(`HTTP ${code} (no Location) for ${url}`));
          if (redirectLeft <= 0) return reject(new Error(`Too many redirects for ${url}`));
          const nextUrl = new URL(loc, url).toString();
          res.resume();
          return resolve(fetchText(nextUrl, opts, redirectLeft - 1));
        }

        // Hard block / rate limit signals from LinkedIn
        if (code === 429 || code === 999 || code === 403) {
          res.resume();
          return reject(new LinkedInBlockedError(code, url));
        }

        const enc = String(res.headers["content-encoding"] || "").toLowerCase();
        let stream = res;
        if (enc.includes("gzip")) stream = res.pipe(zlib.createGunzip());
        else if (enc.includes("deflate")) stream = res.pipe(zlib.createInflate());
        else if (enc.includes("br")) stream = res.pipe(zlib.createBrotliDecompress());

        let data = "";
        stream.setEncoding("utf8");
        stream.on("data", (chunk) => data += chunk);
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

// =====================
// LinkedIn extraction
// =====================
function extractLinkedInJobs(html) {
  const $ = cheerioLoad(html);
  const jobs = [];

  $("ul.jobs-search__results-list li").each((_, el) => {
    const title = normalizeText($(el).find("h3.base-search-card__title").text());
    const company = normalizeText($(el).find("h4.base-search-card__subtitle").text());
    let location = normalizeText($(el).find("span.job-search-card__location").text());
    if (!location) location = normalizeText($(el).text());
    const url = $(el).find("a.base-card__full-link").attr("href");
    if (title && url) jobs.push({ title, url, company, location });
  });

  return dedupeByUrl(jobs);
}

function canonicalizeLinkedInJobUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.hostname.includes("linkedin.com") && u.pathname.startsWith("/jobs/view/")) {
      const lastPart = u.pathname.split("/jobs/view/")[1];
      const canonicalSlug = lastPart.replace(/-\d+$/, "");
      return `https://www.linkedin.com/jobs/view/${canonicalSlug}`;
    }
    return raw;
  } catch {
    return raw;
  }
}

function getDedupeKey(rawUrl) {
  const u = normalizeUrl(rawUrl);
  if (u.includes("linkedin.com/jobs/view/")) return canonicalizeLinkedInJobUrl(u);
  return u;
}

function isHungarianLinkedInUrl(rawUrl) {
  try {
    return new URL(rawUrl).hostname.toLowerCase() === "hu.linkedin.com";
  } catch {
    return false;
  }
}

// =====================
// DB upsert
// =====================
async function upsertJob(client, source, item) {
  const canonicalUrl =
    source === "LinkedIn"
      ? canonicalizeLinkedInJobUrl(item.url)
      : item.url;
  const experience = isInternshipTitle(item.title) ? "diákmunka" : "-";

  await client.query(
    `INSERT INTO job_posts
      (source, title, url, canonical_url, experience, company, first_seen)
     SELECT $1,$2,$3,$4,$5,$6,NOW()
     WHERE NOT EXISTS (
       SELECT 1 FROM job_posts WHERE source = $1 AND canonical_url = $4
     )
     ON CONFLICT (source, url)
        DO NOTHING;
        `,
    [source, item.title, item.url, canonicalUrl, experience, item.company || null]
  );
}

function levelNotBlacklisted(title, desc) {
  const t = normalizeText(title ?? "");
  return !_filters.some((w) => _blacklistRegex(w).test(t));
}

// =====================
// Pagination (opt-in via source.paginate = true)
// =====================
function buildLinkedInPageUrl(searchUrl, start) {
  // Reuse the keywords/geoId/location/etc. params from the original search URL
  // and call the guest "seeMore" endpoint with start=N.
  const orig = new URL(searchUrl);
  const out = new URL(LINKEDIN_GUEST_PAGINATION_URL);
  for (const [k, v] of orig.searchParams.entries()) {
    out.searchParams.set(k, v);
  }
  out.searchParams.set("start", String(start));
  return out.toString();
}

async function fetchAllLinkedInPages(searchUrl, {
  maxPages = 5,
  minDelayMs = 8000,
  maxDelayMs = 15000,
  userAgent,
} = {}) {
  const all = [];
  // Use one UA per source so all pages of one search look like one browser
  // session (real users keep the same UA when scrolling).
  const ua = userAgent || pickUserAgent();
  const referer = "https://www.linkedin.com/jobs/search/";

  // Page 0: the normal search page (returns full HTML with the same list).
  const firstHtml = await fetchText(searchUrl, { userAgent: ua, referer });
  const firstItems = extractLinkedInJobs(firstHtml);
  all.push(...firstItems);

  // If first page already empty, no point paging.
  if (firstItems.length === 0) return dedupeByUrl(all);

  for (let page = 1; page < maxPages; page++) {
    // Delay BEFORE every page (incl. first paginated one) — humans don't
    // scroll instantly after the page renders.
    await randomDelay(minDelayMs, maxDelayMs);
    const pageUrl = buildLinkedInPageUrl(searchUrl, page * LINKEDIN_PAGE_SIZE);
    let html;
    try {
      html = await fetchText(pageUrl, { userAgent: ua, referer: searchUrl });
    } catch (err) {
      if (err instanceof LinkedInBlockedError) throw err; // bubble up — abort cron
      console.error(`pagination stop at start=${page * LINKEDIN_PAGE_SIZE}: ${err.message}`);
      break;
    }
    const items = extractLinkedInJobs(html);
    if (items.length === 0) break;
    all.push(...items);
  }

  return dedupeByUrl(all);
}

// =====================
// Main processing function
// =====================
export async function processLinkedInSources(sources, jobName) {
  if (String(process.env.LINKEDIN_DISABLED || "").toLowerCase() === "true") {
    console.warn(`${jobName}: LINKEDIN_DISABLED=true — skipping run.`);
    return new Response("DISABLED");
  }

  _filters = await loadFilters();

  const client = await pool.connect();
  let blocked = false;

  try {
    for (const p of sources) {
      if (blocked) {
        console.warn(`${jobName}: aborting remaining sources after LinkedIn block.`);
        break;
      }
      await randomDelay(2000, 5000); // longer pause between sources
      const ua = pickUserAgent();
      let rawItems;
      try {
        if (p.paginate) {
          rawItems = await fetchAllLinkedInPages(p.url, {
            maxPages: p.maxPages ?? 5,
            userAgent: ua,
          });
        } else {
          const html = await fetchText(p.url, { userAgent: ua });
          rawItems = extractLinkedInJobs(html);
        }
      } catch (err) {
        if (err instanceof LinkedInBlockedError) {
          console.error(`${jobName}: BLOCKED by LinkedIn (HTTP ${err.status}) at ${p.url} — aborting cron run.`);
          if (ENABLE_FETCH_ERROR_LOGGING) {
            await logFetchError(jobName, { url: p.url, message: err.message, extra: { key: p.key, blocked: true } });
          }
          blocked = true;
          continue;
        }
        if (ENABLE_FETCH_ERROR_LOGGING) {
          await logFetchError(jobName, { url: p.url, message: err.message, extra: { key: p.key } });
        }
        console.error(p.key, "fetch failed:", err.message);
        continue;
      }

      let items = rawItems.filter(it => {
        if (!hasLatinScript(it.title)) return false;
        if (!levelNotBlacklisted(it.title, it.description)) return false;
        if (!titleNotBlacklisted(it.title)) return false;
        if (!isHungarianLinkedInUrl(it.url) && (!it.location || (!it.location.includes("budapest") && !it.location.includes("hungary")))) return false;
        return true;
      });

      for (const it of items) {
        try {
          await upsertJob(client, p.key, it);
        } catch (err) {
          console.error(err);
        }
      }

      console.log(`${p.key}: ${items.length} items processed.`);
    }

    await flagCrossDuplicates(client, { days: 2, label: jobName || "linkedin" });
  } finally {
    console.log(`Script finished at ${new Date().toISOString()}${blocked ? " (ABORTED: LinkedIn block)" : ""}`);
    client.release();
  }

  return new Response(blocked ? "BLOCKED" : "OK");
}
