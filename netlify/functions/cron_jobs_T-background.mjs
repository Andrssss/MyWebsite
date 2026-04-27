/* =========================
  "https://hu.talent.com,
*/



import { Pool } from "pg";
import https from "https";
import http from "http";
import zlib from "zlib";
import { load as cheerioLoad } from "cheerio";
import { loadFilters } from "./load_filters.mjs";
import { logFetchError, withTimeout } from "./_error-logger.mjs";

let _filters = [];

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

const TALENT_SEARCH_URLS = [
  "https://hu.talent.com/jobs?k=fejleszt%C5%91&l=Budapest%2C+HU&date=1",
  "https://hu.talent.com/jobs?k=programoz%C3%B3&l=Budapest%2C+HU&date=1",
  "https://hu.talent.com/jobs?k=tesztel%C5%91&l=Budapest%2C+HU&date=1",
    "https://hu.talent.com/jobs?k=tester&l=Budapest%2C+HU&date=1",
    "https://hu.talent.com/jobs?k=programmer&l=Budapest%2C+HU&date=1",
    "https://hu.talent.com/jobs?k=developer&l=Budapest%2C+HU&date=1",
    "https://hu.talent.com/jobs?k=qa&l=Budapest%2C+HU&date=1",

];

/* ── shared helpers ─────────────────────────────────────────── */

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
    ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid"].forEach((key) =>
      url.searchParams.delete(key)
    );
    return url.toString().replace(/\?$/, "");
  } catch {
    return raw;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
          "Accept-Language": "hu-HU,hu;q=0.9,en;q=0.8",
          "Accept-Encoding": "gzip,deflate,br",
        },
        timeout: 25000,
      },
      (res) => {
        const code = res.statusCode || 0;

        if ([301, 302, 303, 307, 308].includes(code)) {
          const location = res.headers.location;
          if (!location) return reject(new Error(`HTTP ${code} (no Location) for ${url}`));
          if (redirectLeft <= 0) return reject(new Error(`Too many redirects for ${url}`));
          const nextUrl = new URL(location, url).toString();
          res.resume();
          return resolve(fetchText(nextUrl, redirectLeft - 1));
        }

        const encoding = String(res.headers["content-encoding"] || "").toLowerCase();
        let stream = res;

        if (encoding.includes("gzip")) stream = res.pipe(zlib.createGunzip());
        else if (encoding.includes("deflate")) stream = res.pipe(zlib.createInflate());
        else if (encoding.includes("br")) stream = res.pipe(zlib.createBrotliDecompress());

        let body = "";
        stream.setEncoding("utf8");
        stream.on("data", (chunk) => {
          body += chunk;
        });
        stream.on("end", () => {
          if (code >= 200 && code < 300) resolve(body);
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

async function upsertJob(client, sourceKey, item) {
  const canonicalUrl = normalizeUrl(item.url);

  await client.query(
    `INSERT INTO job_posts
      (source, title, url, canonical_url, experience, first_seen)
     VALUES ($1,$2,$3,$4,$5,NOW())
     ON CONFLICT (source, url)
     DO UPDATE SET
       title = EXCLUDED.title,
       canonical_url = EXCLUDED.canonical_url,
       experience = COALESCE(EXCLUDED.experience, job_posts.experience);`,
    [sourceKey, item.title, item.url, canonicalUrl, item.experience]
  );
}

/* ── talent.com ─────────────────────────────────────────────── */

function _blacklistRegex(k) {
  const escaped = normalizeText(k).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i");
}

function isSeniorLike(title) {
  const normalized = normalizeText(title);
  return _filters.some((kw) => _blacklistRegex(kw).test(normalized));
}

const INTERNSHIP_KEYWORDS = [
  "gyakornok", "intern", "internship", "trainee",
  "pályakezdő", "palyakezdo", "diákmunka", "diakmunka",
];

function isInternshipTitle(title) {
  const n = normalizeText(title ?? "");
  return INTERNSHIP_KEYWORDS.some(k => n.includes(k));
}

function inferTalentExperience(title) {
  const normalized = normalizeText(title);
  if (INTERNSHIP_KEYWORDS.some(k => normalized.includes(k))) return "diákmunka";
  if (_filters.some((kw) => normalized.includes(normalizeText(kw))))
    return "senior";
  if (/\bmedior\b|\bmid\b/.test(normalized)) return "medior";
  if (/\bjunior\b|\bpalyakezdo\b|\bentry.?level\b/.test(normalized))
    return "junior";
  return null;
}

function extractTalentJobs(html) {
  const $ = cheerioLoad(html);
  const jobs = [];
  const seen = new Set();

  $("h2").each((_i, el) => {
    const $h2 = $(el);
    const title = normalizeWhitespace($h2.text());
    if (!title) return;

    let viewHref = null;
    let $card = $h2;
    for (let j = 0; j < 8; j++) {
      $card = $card.parent();
      const link = $card.find('a[href*="/view?id="]').first();
      if (link.length) {
        viewHref = link.attr("href");
        break;
      }
    }

    if (!viewHref) return;

    const url = normalizeUrl(
      viewHref.startsWith("http") ? viewHref : `https://hu.talent.com${viewHref}`
    );

    if (seen.has(url)) return;
    seen.add(url);

    jobs.push({
      title,
      url,
      experience: inferTalentExperience(title) ?? "-",
    });
  });

  return jobs;
}

async function fetchAllTalentJobs() {
  const allJobs = [];
  const seen = new Set();

  for (const searchUrl of TALENT_SEARCH_URLS) {
    try {
      const html = await fetchText(searchUrl);
      const jobs = extractTalentJobs(html);

      for (const job of jobs) {
        const canonical = normalizeUrl(job.url);
        if (!seen.has(canonical)) {
          seen.add(canonical);
          allJobs.push(job);
        }
      }

      console.log(`talent: ${searchUrl.match(/k=([^&]+)/)?.[1]} → ${jobs.length} jobs`);
    } catch (err) {
      await logFetchError("cron_jobs_T", { url: searchUrl, message: err.message, extra: { source: "talent" } });
      console.log(`talent: failed ${searchUrl}: ${err.message}`);
    }

    await sleep(1000);
  }

  return allJobs;
}

/* ── handler ────────────────────────────────────────────────── */

const _runJob = withTimeout("cron_jobs_T-background", async (request) => {
  _filters = await loadFilters();
  const client = await pool.connect();

  try {
    /* talent.com */
    const talentJobs = (await fetchAllTalentJobs()).filter((job) => !isSeniorLike(job.title));
    console.log(`talent: ${talentJobs.length} unique jobs found (after senior filter)`);

    for (const job of talentJobs) {
      await upsertJob(client, "talent", job);
    }
    console.log(`talent: ${talentJobs.length} jobs processed`);

    return new Response("OK");
  } finally {
    client.release();
  }
});

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  const expected = process.env.CRON_SECRET;
  if (!expected || token !== expected) {
    return new Response("Unauthorized", { status: 401 });
  }
  return _runJob(request);
};
