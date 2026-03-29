export const config = {
  schedule: "23 4-23 * * *",
};

import { Pool } from "pg";
import https from "https";
import http from "http";
import zlib from "zlib";
import { load as cheerioLoad } from "cheerio";

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

const SOURCE_KEY = "jooble";

/* Two search queries: programozó + tesztelő, both Budapest */
const SEARCH_URLS = [
  "https://hu.jooble.org/SearchResult?rgns=Budapest&ukw=programoz%C3%B3",
  "https://hu.jooble.org/SearchResult?date=8&rgns=Budapest&ukw=tesztel%C5%91",
];

/* ── helpers ─────────────────────────────────────────────────── */

function normalizeWhitespace(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeUrl(raw) {
  try {
    const url = new URL(raw);
    url.hash = "";
    [
      "utm_source", "utm_medium", "utm_campaign", "utm_term",
      "utm_content", "fbclid", "gclid",
    ].forEach((key) => url.searchParams.delete(key));
    return url.toString().replace(/\?$/, "");
  } catch {
    return raw;
  }
}

/**
 * Strip Jooble tracking params from job URL, keep only the base path.
 * e.g. /jdp/-755823920645225761?ckey=...&pos=1&... → /jdp/-755823920645225761
 */
function canonicalJoobleUrl(href) {
  try {
    const url = new URL(href, "https://hu.jooble.org");
    return `https://hu.jooble.org${url.pathname}`;
  } catch {
    return href;
  }
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
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "hu-HU,hu;q=0.9,en;q=0.8",
          "Accept-Encoding": "gzip,deflate,br",
          Connection: "keep-alive",
          "Sec-Fetch-Dest": "document",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Site": "none",
          "Sec-Fetch-User": "?1",
          "Upgrade-Insecure-Requests": "1",
        },
        timeout: 50000,
      },
      (res) => {
        const code = res.statusCode || 0;

        if ([301, 302, 303, 307, 308].includes(code)) {
          const location = res.headers.location;
          if (!location)
            return reject(new Error(`HTTP ${code} (no Location) for ${url}`));
          if (redirectLeft <= 0)
            return reject(new Error(`Too many redirects for ${url}`));
          const nextUrl = new URL(location, url).toString();
          res.resume();
          return resolve(fetchText(nextUrl, redirectLeft - 1));
        }

        const encoding = String(
          res.headers["content-encoding"] || ""
        ).toLowerCase();
        let stream = res;

        if (encoding.includes("gzip"))
          stream = res.pipe(zlib.createGunzip());
        else if (encoding.includes("deflate"))
          stream = res.pipe(zlib.createInflate());
        else if (encoding.includes("br"))
          stream = res.pipe(zlib.createBrotliDecompress());

        let body = "";
        stream.setEncoding("utf8");
        stream.on("data", (chunk) => {
          body += chunk;
        });
        stream.on("end", () => resolve({ code, body }));
        stream.on("error", reject);
      }
    );

    req.on("timeout", () => req.destroy(new Error(`Timeout for ${url}`)));
    req.on("error", reject);
    req.end();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function inferExperience(title) {
  const normalized = normalizeText(title);
  if (/\bmedior\b/.test(normalized)) return "medior";
  if (/\bjunior\b|\bgyakornok\b|\bpalyakezdo\b|\bentry.?level\b|\btanulo\b|\btrainee\b|\bintern\b/.test(normalized))
    return "junior";
  if (/\bsenior\b|\bszenior\b|\blead\b|\bprincipal\b|\barchitect\b|\bstaff\b|\bhead\b/.test(normalized))
    return "senior";
  return null;
}

function isBlocked(code, body) {
  if (code === 403) return true;
  if (body.includes("Just a moment") || body.includes("Security Check"))
    return true;
  return false;
}

/* ── parse Jooble search results HTML ────────────────────────── */

function parseSearchPage(html) {
  const $ = cheerioLoad(html);
  const jobs = [];

  // Jooble job links: /jdp/{id} (external redirect) or /desc/{id} (internal)
  $('a[href*="/jdp/"], a[href*="/desc/"]').each((_i, el) => {
    const $a = $(el);
    const href = $a.attr("href") || "";

    // Only match actual job detail links
    if (!/\/(jdp|desc)\/[-\d]+/.test(href)) return;

    const title = normalizeWhitespace($a.text());
    if (!title || title.length < 3) return;

    // Try to find company from nearby elements
    const $card = $a.closest("article, li, div").first();
    const company = normalizeWhitespace(
      $card.find("[class*='company'], [class*='employer']").first().text()
    );

    const fullUrl = new URL(href, "https://hu.jooble.org").toString();
    const canonical = canonicalJoobleUrl(href);

    jobs.push({
      title,
      company,
      url: fullUrl,
      canonical,
      experience: inferExperience(title),
    });
  });

  return jobs;
}

/* ── fetch all jobs from both searches ───────────────────────── */

async function fetchAllJoobleJobs() {
  const allJobs = [];
  const seenCanonicals = new Set();

  for (let i = 0; i < SEARCH_URLS.length; i++) {
    const searchUrl = SEARCH_URLS[i];
    const label = i === 0 ? "programozó" : "tesztelő";

    let result;
    try {
      result = await fetchText(searchUrl);
    } catch (err) {
      console.log(`${SOURCE_KEY} [${label}]: fetch error: ${err.message}`);
      continue;
    }

    if (isBlocked(result.code, result.body)) {
      console.log(
        `${SOURCE_KEY} [${label}]: blocked (HTTP ${result.code}) — skipping`
      );
      continue;
    }

    if (result.code < 200 || result.code >= 300) {
      console.log(
        `${SOURCE_KEY} [${label}]: HTTP ${result.code} — skipping`
      );
      continue;
    }

    const pageJobs = parseSearchPage(result.body);
    console.log(`${SOURCE_KEY} [${label}]: found ${pageJobs.length} jobs`);

    for (const job of pageJobs) {
      if (!seenCanonicals.has(job.canonical)) {
        seenCanonicals.add(job.canonical);
        allJobs.push(job);
      }
    }

    // polite delay between searches
    if (i < SEARCH_URLS.length - 1) await sleep(2000);
  }

  return allJobs;
}

/* ── upsert ──────────────────────────────────────────────────── */

async function upsertJob(client, item) {
  await client.query(
    `INSERT INTO job_posts
      (source, title, url, canonical_url, experience, first_seen)
     VALUES ($1,$2,$3,$4,$5,NOW())
     ON CONFLICT (source, canonical_url)
     DO UPDATE SET
       title = EXCLUDED.title,
       url = EXCLUDED.url,
       experience = COALESCE(EXCLUDED.experience, job_posts.experience);`,
    [SOURCE_KEY, item.title, item.url, item.canonical, item.experience]
  );
}

/* ── handler ─────────────────────────────────────────────────── */

export default async () => {
  const client = await pool.connect();

  try {
    const jobs = await fetchAllJoobleJobs();
    console.log(`${SOURCE_KEY}: ${jobs.length} unique jobs found total`);

    for (const job of jobs) {
      await upsertJob(client, job);
    }

    console.log(`${SOURCE_KEY}: ${jobs.length} jobs processed`);
    return new Response("OK");
  } finally {
    client.release();
  }
};
