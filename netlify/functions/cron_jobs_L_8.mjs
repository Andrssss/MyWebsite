export const config = {
  schedule: "16 4-23 * * *",
};
/* =========================
// jr tester
// jr developer
*/

import { Pool } from "pg";
import https from "https";
import http from "http";
import zlib from "zlib";
import { load as cheerioLoad } from "cheerio";
import { loadFilters } from "./load_filters.mjs";
import { logFetchError, withTimeout } from "./_error-logger.mjs";

let _filters = [];
const ENABLE_FETCH_ERROR_LOGGING = false;

/* ---------------------
   DB connection
--------------------- */
const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

/* ---------------------
   Helper functions
--------------------- */
function normalizeText(s) {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const INTERNSHIP_KEYWORDS = [
  "gyakornok", "intern", "internship", "trainee",
  "pályakezdő", "palyakezdo", "diákmunka", "diakmunka",
];
function isInternshipTitle(title) {
  const t = normalizeText(title);
  return INTERNSHIP_KEYWORDS.some(k => t.includes(k));
}

function titleNotBlacklisted(title) {
  const t = normalizeText(title);
  return !_filters.some(word => t.includes(normalizeText(word)));
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

/* =====================
   URL helpers
===================== */
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

/* ---------------------
   Fetch helper
--------------------- */
function fetchText(url, redirectLeft = 5) {
  return new Promise((resolve, reject) => {
    console.log(`Script started at ${new Date().toISOString()}`);
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
          return resolve(fetchText(nextUrl, redirectLeft - 1));
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

/* ---------------------
   LinkedIn extraction
--------------------- */
function extractLinkedInJobs(html) {
  const $ = cheerioLoad(html);
  const jobs = [];

  $("ul.jobs-search__results-list li").each((_, el) => {
    const title = normalizeText($(el).find("h3.base-search-card__title").text());
    const company = normalizeText($(el).find("h4.base-search-card__subtitle").text());
    const location = normalizeText($(el).find("span.job-search-card__location").text());
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

/* ---------------------
   DB upsert
--------------------- */
async function upsertJob(client, source, item) {
  const canonicalUrl =
    source === "LinkedIn"
      ? canonicalizeLinkedInJobUrl(item.url)
      : item.url;
  const experience = isInternshipTitle(item.title) ? "diákmunka" : "-";

  await client.query(
    `INSERT INTO job_posts
      (source, title, url, canonical_url, experience, first_seen)
     SELECT $1,$2,$3,$4,$5,NOW()
     WHERE NOT EXISTS (
       SELECT 1 FROM job_posts WHERE source = $1 AND canonical_url = $4
     )
     ON CONFLICT (source, url)
        DO NOTHING;
        `,
    [source, item.title, item.url, canonicalUrl, experience]
  );
}

function levelNotBlacklisted(title, desc) {
  const t = normalizeText(`${title ?? ""} ${desc ?? ""}`);
  return !_filters.some((w) => t.includes(normalizeText(w)));
}

export default withTimeout("cron_jobs_L_8", async () => {
  _filters = await loadFilters();

  const SOURCES = [
    // Full-Stack
    { key: "LinkedIn", label: "LinkedIn JR FULL-STACK", url: "https://www.linkedin.com/jobs/search/?distance=0&f_E=2&f_TPR=r86400&keywords=Full%20Stack%20Engineer&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
    { key: "LinkedIn", label: "LinkedIn JR FULL-STACK", url: "https://www.linkedin.com/jobs/search/?distance=0&f_E=1&f_TPR=r86400&keywords=Full%20Stack%20Engineer&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
    { key: "LinkedIn", label: "LinkedIn JR FULL-STACK", url: "https://www.linkedin.com/jobs/search/?distance=0&f_E=2&f_TPR=r604800&keywords=Full%20Stack%20Engineer&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
    { key: "LinkedIn", label: "LinkedIn JR FULL-STACK", url: "https://www.linkedin.com/jobs/search/?distance=0&f_E=1&f_TPR=r604800&keywords=Full%20Stack%20Engineer&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
    { key: "LinkedIn", label: "LinkedIn JR FULL-STACK", url: "https://www.linkedin.com/jobs/search/?distance=10&f_E=2&f_TPR=r86400&keywords=Full%20Stack%20Engineer&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
    { key: "LinkedIn", label: "LinkedIn JR FULL-STACK", url: "https://www.linkedin.com/jobs/search/?distance=10&f_E=1&f_TPR=r86400&keywords=Full%20Stack%20Engineer&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
    { key: "LinkedIn", label: "LinkedIn JR FULL-STACK", url: "https://www.linkedin.com/jobs/search/?distance=10&f_E=2&f_TPR=r604800&keywords=Full%20Stack%20Engineer&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
    { key: "LinkedIn", label: "LinkedIn JR FULL-STACK", url: "https://www.linkedin.com/jobs/search/?distance=10&f_E=1&f_TPR=r604800&keywords=Full%20Stack%20Engineer&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER" },

    // jr
    { key: "LinkedIn", label: "LinkedIn JR DEVELOPER", url: "https://www.linkedin.com/jobs/search/?distance=0&f_E=2&f_TPR=r86400&keywords=Junior&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
    { key: "LinkedIn", label: "LinkedIn JR DEVELOPER", url: "https://www.linkedin.com/jobs/search/?distance=0&f_E=1&f_TPR=r86400&keywords=Junior&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
    { key: "LinkedIn", label: "LinkedIn JR DEVELOPER", url: "https://www.linkedin.com/jobs/search/?distance=0&f_E=2&f_TPR=r604800&keywords=Junior&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
  ];

  const client = await pool.connect();

  try {
    for (const p of SOURCES) {
      await randomDelay();
      let html;
      try {
        html = await fetchText(p.url);
      } catch (err) {
        if (ENABLE_FETCH_ERROR_LOGGING) {
          await logFetchError("cron_jobs_L_8", { url: p.url, message: err.message });
        }
        console.error(p.key, "fetch failed:", err.message);
        continue;
      }

      const rawItems = extractLinkedInJobs(html);

      const items = rawItems.filter(it => {
        if (!levelNotBlacklisted(it.title, it.description)) return false;
        if (!titleNotBlacklisted(it.title)) return false;
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
  } finally {
    console.log(`Script started at ${new Date().toISOString()}`);
    client.release();
  }

  return new Response("OK");
});
