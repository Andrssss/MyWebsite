export const config = {
  schedule: "22 4-23 * * *",
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

const SOURCE_KEY = "melonjobs";
const MELONJOBS_API_URL = "https://melonjobs.hu/wp-json/wp/v2/job-listings?job-categories=63&per_page=100&page=1";
const MAX_PAGES = 20;

function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeWhitespace(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
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
        timeout: 50000,
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

function isBudapestLocation(location) {
  const normalized = normalizeText(location);
  return normalized.includes("budapest") || /\b1\d{3}\b/.test(normalized);
}

function inferExperience(title, description) {
  const normalized = normalizeText(`${title ?? ""} ${description ?? ""}`);

  if (/\bmedior\b/.test(normalized)) return "medior";
  if (/\bjunior\b|\bpalyakezdo\b|\bentry level\b/.test(normalized)) return "junior";

  return null;
}

function isSeniorLike(title, description) {
  const normalized = normalizeText(`${title ?? ""} ${description ?? ""}`);
  return /\bsenior\b|\bszenior\b|\blead\b|\bprincipal\b|\barchitect\b|\bstaff\b|\bhead\b|\bexpert\b/.test(normalized);
}

function extractJobs(payload) {
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
    const pageJobs = extractJobs(payload);

    if (pageJobs.length === 0 && (!Array.isArray(payload) || payload.length === 0)) break;

    jobs.push(...pageJobs);

    if (!Array.isArray(payload) || payload.length < perPage) break;
  }

  return jobs;
}

async function upsertJob(client, item) {
  const canonicalUrl = normalizeUrl(item.url);

  await client.query(
    `INSERT INTO job_posts
      (source, title, url, canonical_url, experience, first_seen)
     VALUES ($1,$2,$3,$4,$5,NOW())
     ON CONFLICT (source, canonical_url)
     DO UPDATE SET
       title = EXCLUDED.title,
       url = EXCLUDED.url,
       experience = COALESCE(EXCLUDED.experience, job_posts.experience);`,
    [SOURCE_KEY, item.title, item.url, canonicalUrl, item.experience]
  );
}

export default async () => {
  const client = await pool.connect();

  try {
    const jobs = await fetchAllMelonJobs();

    for (const job of jobs) {
      await upsertJob(client, job);
    }

    console.log(`${SOURCE_KEY}: ${jobs.length} jobs processed.`);
    return new Response("OK");
  } finally {
    client.release();
  }
};