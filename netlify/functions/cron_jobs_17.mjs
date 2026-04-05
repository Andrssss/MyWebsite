export const config = {
  schedule: "14 4-23 * * *",
};

/* =========================
  "https://api.dreamjobs.hu/api/v1/jobs?region=hu&page=1&tags%5Bjob-category%5D%5B%5D=57&tags%5Bjob-category%5D%5B%5D=44&tags%5Bjob-category%5D%5B%5D=49&tags%5Bjob-category%5D%5B%5D=55&tags%5Bjob-category%5D%5B%5D=58&tags%5Boffice-location%5D%5B%5D=2925&scope%5B%5D=isNotBlue&per_page=50",
  "https://melonjobs.hu/wp-json/wp/v2/job-listings?job-categories=63&per_page=100&page=1";
  "https://jobs.kuka.com/tile-search-results/?q=&locationsearch=HU&optionsFacetsDD_department=IT";
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

const MAX_PAGES = 20;

const DREAMJOBS_API_URLS = [
  "https://api.dreamjobs.hu/api/v1/jobs?region=hu&page=1&tags%5Bjob-category%5D%5B%5D=57&tags%5Bjob-category%5D%5B%5D=44&tags%5Bjob-category%5D%5B%5D=49&tags%5Bjob-category%5D%5B%5D=55&tags%5Bjob-category%5D%5B%5D=58&tags%5Boffice-location%5D%5B%5D=2925&scope%5B%5D=isNotBlue&per_page=50",
  "https://api.dreamjobs.hu/api/v1/jobs?region=hu&page=1&tags%5Bjob-category%5D%5B%5D=44&tags%5Bjob-category%5D%5B%5D=49&tags%5Bjob-category%5D%5B%5D=57&tags%5Bjob-category%5D%5B%5D=22381&tags%5Boffice-location%5D%5B%5D=2925&tags%5Boffice-location%5D%5B%5D=15990&scope%5B%5D=isNotBlue&per_page=50",
];

const MELONJOBS_API_URL =
  "https://melonjobs.hu/wp-json/wp/v2/job-listings?job-categories=63&per_page=100&page=1";

const KUKA_API_URL =
  "https://jobs.kuka.com/tile-search-results/?q=&locationsearch=HU&optionsFacetsDD_department=IT";


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
          "User-Agent": "JobWatcher/1.0",
          Accept: "application/json,text/plain;q=0.9,*/*;q=0.8",
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

async function fetchJson(url) {
  const text = await fetchText(url);
  return JSON.parse(text);
}

function htmlToText(html) {
  const $ = cheerioLoad(`<div>${html ?? ""}</div>`);
  return normalizeWhitespace($.text());
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
    [sourceKey, item.title, item.url, canonicalUrl, item.experience ?? "-"]
  );
}

/* ── DreamJobs ──────────────────────────────────────────────── */

function buildDreamJobsUrl(job) {
  const lang = /^[a-z]{2}$/i.test(String(job?.primary_lang || "")) ? String(job.primary_lang).toLowerCase() : "hu";
  const companySlug = normalizeWhitespace(job?.company?.slug);
  const localizedSlug =
    normalizeWhitespace(job?.slugs?.[`slug_${lang}`]) ||
    normalizeWhitespace(job?.slugs?.slug_hu) ||
    normalizeWhitespace(job?.slug);

  if (!companySlug || !localizedSlug) return null;

  return normalizeUrl(`https://dreamjobs.hu/${lang}/job/${companySlug}/${localizedSlug}`);
}

function pickJobTitle(job) {
  const lang = /^[a-z]{2}$/i.test(String(job?.primary_lang || "")) ? String(job.primary_lang).toLowerCase() : "hu";
  return normalizeWhitespace(job?.name?.[lang]) || normalizeWhitespace(job?.name?.hu) || normalizeWhitespace(job?.name?.en) || null;
}

function extractDreamJobs(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : [];

  return rows
    .map((job) => ({
      title: pickJobTitle(job),
      url: buildDreamJobsUrl(job),
      experience: normalizeWhitespace(job?.tags?.job_level?.slug) || null,
    }))
    .filter((item) => item.title && item.url);
}

async function fetchAllDreamJobs() {
  const jobs = [];
  const seen = new Set();

  for (const apiUrl of DREAMJOBS_API_URLS) {
    const baseUrl = new URL(apiUrl);
    const perPage = Number.parseInt(baseUrl.searchParams.get("per_page") || "50", 10) || 50;

    for (let page = 1; page <= MAX_PAGES; page += 1) {
      baseUrl.searchParams.set("page", String(page));
      const payload = await fetchJson(baseUrl.toString());
      const pageJobs = extractDreamJobs(payload);

      if (pageJobs.length === 0) break;

      for (const job of pageJobs) {
        const key = normalizeUrl(job.url);
        if (!seen.has(key)) {
          seen.add(key);
          jobs.push(job);
        }
      }

      if (pageJobs.length < perPage) break;
    }
  }

  return jobs;
}

/* ── MelonJobs ──────────────────────────────────────────────── */


function isBudapestLocation(location) {
  const normalized = normalizeText(location);
  return normalized.includes("budapest") || /\b1\d{3}\b/.test(normalized);
}

const INTERNSHIP_KEYWORDS = [
  "gyakornok", "intern", "internship", "trainee",
  "pályakezdő", "palyakezdo", "diákmunka", "diakmunka",
];


function inferExperience(title, description) {
  const normalized = normalizeText(`${title ?? ""} ${description ?? ""}`);

  if (INTERNSHIP_KEYWORDS.some(k => normalized.includes(k))) return "diákmunka";
  if (_filters.some((kw) => normalized.includes(normalizeText(kw)))) return "senior";
  if (/\bmedior\b/.test(normalized)) return "medior";
  if (/\bjunior\b|\bpalyakezdo\b|\bentry level\b/.test(normalized)) return "junior";

  return null;
}

function isSeniorLike(title, description) {
  const normalized = normalizeText(`${title ?? ""} ${description ?? ""}`);
  return _filters.some((kw) => normalized.includes(normalizeText(kw)));
}

function extractMelonJobs(payload) {
  const rows = Array.isArray(payload) ? payload : [];

  return rows
    .map((job) => {
      const title = htmlToText(job?.title?.rendered);
      const description = htmlToText(job?.content?.rendered);
      const url = normalizeUrl(job?.link || "");
      const location = normalizeWhitespace(job?.meta?._job_location);

      return {
        title,
        description,
        url,
        location,
        experience: inferExperience(title, description),
      };
    })
    .filter((job) => job.title && job.url)
    .filter((job) => isBudapestLocation(job.location))
    .filter((job) => !isSeniorLike(job.title, job.description));
}

async function fetchAllMelonJobs() {
  const jobs = [];
  const baseUrl = new URL(MELONJOBS_API_URL);
  const perPage = Number.parseInt(baseUrl.searchParams.get("per_page") || "100", 10) || 100;

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    baseUrl.searchParams.set("page", String(page));
    const payload = await fetchJson(baseUrl.toString());
    const pageJobs = extractMelonJobs(payload);

    if (pageJobs.length === 0 && (!Array.isArray(payload) || payload.length === 0)) break;

    jobs.push(...pageJobs);

    if (!Array.isArray(payload) || payload.length < perPage) break;
  }

  return jobs;
}

/* ── KUKA ───────────────────────────────────────────────────── */

function inferKukaExperience(title) {
  const normalized = normalizeText(title);
  if (_filters.some((kw) => normalized.includes(normalizeText(kw))))
    return "senior";
  if (/\bmedior\b|\bmid\b/.test(normalized)) return "medior";
  if (/\bjunior\b|\bpalyakezdo\b|\bentry.?level\b|\btrainee\b|\bintern\b|\bgyakornok\b/.test(normalized))
    return "junior";
  return null;
}

function extractKukaJobs(html) {
  const $ = cheerioLoad(html);
  const jobs = [];
  const seen = new Set();

  $("li[data-url]").each((_i, el) => {
    const $el = $(el);
    const path = $el.attr("data-url");
    if (!path) return;

    const url = normalizeUrl(`https://jobs.kuka.com${path.replace(/&amp;/g, "&")}`);
    if (seen.has(url)) return;
    seen.add(url);

    const title = normalizeWhitespace(
      $el.find(".jobTitle-link").first().text() ||
        $el.find(".title a").first().text() ||
        $el.find("a[href]").first().text()
    );
    if (!title) return;

    jobs.push({
      title,
      url,
      experience: inferKukaExperience(title),
    });
  });

  return jobs;
}

async function fetchAllKukaJobs() {
  const html = await fetchText(KUKA_API_URL);
  return extractKukaJobs(html);
}
/* ── handler ────────────────────────────────────────────────── */

export default withTimeout("cron_jobs_17", async () => {
  _filters = await loadFilters();
  const client = await pool.connect();

  try {
    /* DreamJobs */
    const dreamJobs = (await fetchAllDreamJobs()).filter((job) => !isSeniorLike(job.title, ""));
    console.log(`dreamjobs: ${dreamJobs.length} jobs found`);

    for (const job of dreamJobs) {
      await upsertJob(client, "dreamjobs", job);
    }
    console.log(`dreamjobs: ${dreamJobs.length} jobs processed`);

    /* MelonJobs */
    const melonJobs = await fetchAllMelonJobs();
    console.log(`melonjobs: ${melonJobs.length} jobs found`);

    for (const job of melonJobs) {
      await upsertJob(client, "melonjobs", job);
    }
    console.log(`melonjobs: ${melonJobs.length} jobs processed`);

    /* KUKA */
    const kukaJobs = (await fetchAllKukaJobs()).filter((job) => !isSeniorLike(job.title, ""));
    console.log(`kuka: ${kukaJobs.length} jobs found`);

    for (const job of kukaJobs) {
      await upsertJob(client, "kuka", job);
    }
    console.log(`kuka: ${kukaJobs.length} jobs processed`);

    return new Response("OK");
  } finally {
    client.release();
  }
});