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

const SOURCE_KEY = "indeed";
const MAX_PAGES = 4;
const PAGE_SIZE = 15;
const BASE_SEARCH_URL =
  "https://hu.indeed.com/jobs?q=fejleszt%C5%91&l=budapest&radius=25&limit=15";

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
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
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

/* ── parse Indeed search results HTML ────────────────────────── */

function parseSearchPage(html) {
  const $ = cheerioLoad(html);
  const jobs = [];

  // Strategy 1: data-jk attributes on card elements
  $("[data-jk]").each((_i, el) => {
    const $el = $(el);
    const jk = $el.attr("data-jk");
    if (!jk) return;

    const title = normalizeWhitespace(
      $el.find("h2.jobTitle span").last().text() ||
        $el.find("h2 span[id]").text() ||
        $el.find("h2").text()
    );
    const company = normalizeWhitespace(
      $el.find('[data-testid="company-name"]').text() ||
        $el.find(".companyName").text() ||
        $el.find(".company_location .css-92r8pb-companyName").text()
    );

    if (!title) return;

    jobs.push({
      jk,
      title,
      company,
      url: normalizeUrl(`https://hu.indeed.com/viewjob?jk=${jk}`),
      experience: inferExperience(title),
    });
  });

  // Strategy 2 fallback: extract fromjk from salary links if no data-jk found
  if (jobs.length === 0) {
    const seenJks = new Set();
    $("a[href*='fromjk=']").each((_i, el) => {
      const href = $(el).attr("href") || "";
      const match = href.match(/fromjk=([a-f0-9]+)/);
      if (!match) return;
      const jk = match[1];
      if (seenJks.has(jk)) return;
      seenJks.add(jk);

      // Walk up to find the job card container
      const $card = $(el).closest("li, .job_seen_beacon, .resultContent, [class*='Result']");
      const title = normalizeWhitespace(
        $card.find("h2").first().text() || $(el).text()
      );

      if (!title) return;

      const company = normalizeWhitespace(
        $card.find('[data-testid="company-name"]').text() ||
          $card.find(".companyName").text()
      );

      jobs.push({
        jk,
        title,
        company,
        url: normalizeUrl(`https://hu.indeed.com/viewjob?jk=${jk}`),
        experience: inferExperience(title),
      });
    });
  }

  return jobs;
}

function isBlocked(code, body) {
  if (code === 403) return true;
  if (body.includes("Security Check") || body.includes("Just a moment"))
    return true;
  return false;
}

/* ── fetch all pages ─────────────────────────────────────────── */

async function fetchAllIndeedJobs() {
  const allJobs = [];
  const seenJks = new Set();

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const start = page * PAGE_SIZE;
    const url = `${BASE_SEARCH_URL}&start=${start}`;

    let result;
    try {
      result = await fetchText(url);
    } catch (err) {
      console.log(`${SOURCE_KEY}: page ${page} fetch error: ${err.message}`);
      break;
    }

    if (isBlocked(result.code, result.body)) {
      console.log(
        `${SOURCE_KEY}: blocked (HTTP ${result.code}) on page ${page} — stopping`
      );
      break;
    }

    if (result.code < 200 || result.code >= 300) {
      console.log(
        `${SOURCE_KEY}: HTTP ${result.code} on page ${page} — stopping`
      );
      break;
    }

    const pageJobs = parseSearchPage(result.body);
    console.log(`${SOURCE_KEY}: page ${page} found ${pageJobs.length} jobs`);

    if (pageJobs.length === 0) break;

    for (const job of pageJobs) {
      if (!seenJks.has(job.jk)) {
        seenJks.add(job.jk);
        allJobs.push(job);
      }
    }

    if (pageJobs.length < PAGE_SIZE) break;

    // polite delay between pages
    if (page < MAX_PAGES - 1) await sleep(2000);
  }

  return allJobs;
}

/* ── upsert ──────────────────────────────────────────────────── */

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

/* ── handler ─────────────────────────────────────────────────── */

export default async () => {
  const client = await pool.connect();

  try {
    const jobs = await fetchAllIndeedJobs();
    console.log(`${SOURCE_KEY}: ${jobs.length} jobs found`);

    for (const job of jobs) {
      await upsertJob(client, job);
    }

    console.log(`${SOURCE_KEY}: ${jobs.length} jobs processed`);
    return new Response("OK");
  } finally {
    client.release();
  }
};
