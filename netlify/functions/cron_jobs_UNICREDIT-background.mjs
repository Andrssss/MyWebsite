/*
  UniCredit Bank Hungary scraper
  Platform: Avature SSR — jobs in static HTML on the list URL
  URL pre-filters Budapest + IT job categories (no extra filtering needed)

  Flow:
    1. GET list URL (jobRecordsPerPage=100)
    2. Parse <article class="article--result"> blocks → title + URL
    3. Skip if isSeniorLike(title) OR title contains "senior"
    4. Intern: isInternshipTitle(title)
    5. Fetch detail page → extractBodyExperience for non-intern jobs
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

const LIST_URL =
  "https://careers.unicredit.eu/hu_HU/jobsuche/SearchJobs/" +
  "?1286=%5B1888%5D&1286_format=1068&" +
  "&12248=%5B12264283%5D&12248_format=8929" +
  "&7620=%5B8883456%2C8883450%2C8883440%2C12016019%5D&7620_format=6375" +
  "&listFilterMode=1&jobRecordsPerPage=100";

/* ── helpers ─────────────────────────────────────────────────── */

function normalizeText(v) {
  return String(v ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeWhitespace(v) {
  return String(v ?? "").replace(/\s+/g, " ").trim();
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
  if (n.includes("senior") || n.includes("szenior")) return true;
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
          Accept: "text/html,*/*;q=0.8",
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
          code >= 200 && code < 300 ? resolve(body) : reject(new Error(`HTTP ${code} for ${url}`))
        );
        stream.on("error", reject);
      }
    );
    req.on("timeout", () => req.destroy(new Error(`Timeout for ${url}`)));
    req.on("error", reject);
    req.end();
  });
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

export default withTimeout("cron_jobs_UNICREDIT-background", async () => {
  _filters = await loadFilters();
  const client = await pool.connect();
  try {
    let listHtml;
    try {
      listHtml = await fetchText(LIST_URL);
    } catch (err) {
      await logFetchError("cron_jobs_UNICREDIT-background", { url: LIST_URL, message: err.message });
      console.error(`[unicredit] list fetch failed: ${err.message}`);
      return;
    }

    const $ = cheerioLoad(listHtml);
    const articles = $("article.article--result").toArray();
    console.log(`[unicredit] list: ${articles.length} jobs found`);

    const jobs = [];
    for (const el of articles) {
      const $a = $(el).find("h3.article__header__text__title--6 a").first();
      const title = normalizeWhitespace($a.text());
      const url = normalizeWhitespace($a.attr("href"));
      if (title && url) jobs.push({ title, url });
    }

    let newlyInserted = 0;
    let alreadyExisted = 0;
    let skippedSenior = 0;
    let skippedNoTitle = 0;
    let detailFetchFailed = 0;

    for (const job of jobs) {
      try {
        if (!job.title) {
          skippedNoTitle++;
          console.log(`[unicredit] SKIP no-title → ${job.url}`);
          continue;
        }
        if (isSeniorLike(job.title)) {
          skippedSenior++;
          console.log(`[unicredit] SKIP senior "${job.title}" → ${job.url}`);
          continue;
        }

        let source = "unicredit";
        let experience;

        if (isInternshipTitle(job.title)) {
          experience = "diákmunka";
        } else {
          await sleep(800);
          let detailHtml;
          try {
            detailHtml = await fetchText(job.url);
          } catch (err) {
            detailFetchFailed++;
            await logFetchError("cron_jobs_UNICREDIT-background", { url: job.url, message: err.message });
            console.error(`[unicredit] detail fetch failed ${job.url}: ${err.message}`);
            continue;
          }
          // Body uses em-dash ("1–3 év") which extractBodyExperience may not match
          const normalizedHtml = detailHtml.replace(/–/g, "-");
          experience = extractBodyExperience(normalizedHtml) || "-";
        }

        const wasNew = await upsertJob(client, source, {
          title: job.title,
          url: job.url,
          experience,
        });
        if (wasNew) {
          newlyInserted++;
          console.log(`[unicredit] NEW [${source}] "${job.title}" exp=${experience} → ${job.url}`);
        } else {
          alreadyExisted++;
          console.log(`[unicredit] EXISTS [${source}] "${job.title}" → ${job.url}`);
        }
      } catch (err) {
        console.error(`[unicredit] job processing failed: ${err.message}`);
      }
    }

    console.log(
      `[unicredit] DONE — total=${jobs.length}, new=${newlyInserted}, existed=${alreadyExisted}, ` +
      `skipped_senior=${skippedSenior}, skipped_no_title=${skippedNoTitle}, fetch_failed=${detailFetchFailed}`
    );
  } finally {
    client.release();
  }
});
