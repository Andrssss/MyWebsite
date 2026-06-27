/*
  OTP Bank — Pályakezdő / Informatika és digitalizáció scraper

  List page is rendered server-side; jobs appear as <li class="job-tile">
  with data-url attribute pointing to /otp/job/... or /leanyvallalatok/job/...

  Flow:
    1. Fetch list page → extract data-url job links
    2. Fetch each detail page
    3. Parse <title> for job title
    4. extractBodyExperience → experience field
    5. Senior filter via _filters
    6. Upsert to job_posts (source = "otp")

  Note: Unlike the diákmunka URLs handled in cron_jobs_DIAK_3, these jobs
  are *adult* "Pályakezdő" positions that may require real experience.
*/

import { Pool } from "pg";
import https from "https";
import http from "http";
import zlib from "zlib";
import { load as cheerioLoad } from "cheerio";
import { loadFilters } from "./load_filters.mjs";
import { logFetchError, withTimeout } from "./_error-logger.mjs";
import { reconcileActive } from "./_active_core.mjs";
import { extractBodyExperience, isJuniorTitle, isMidLevelTitle } from "./_experience_core.mjs";

let _filters = [];

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

const BASE = "https://karrier.otpbank.hu";
const LIST_URL =
  `${BASE}/search/?searchby=location&createNewAlert=false&q=&locationsearch=` +
  `&geolocation=&optionsFacetsDD_city=Budapest&optionsFacetsDD_customfield1=P%C3%A1lyakezd%C5%91` +
  `&optionsFacetsDD_customfield2=Informatika+%C3%A9s+digitaliz%C3%A1ci%C3%B3&optionsFacetsDD_title=`;

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
    // SuccessFactors routes purely by the trailing numeric job-req id; the slug
    // segment is decorative (any slug serves the same job) and can drift over time
    // — title edits, the embedded location id ("…-1131"), encoding. If the slug
    // changes, the same job gets a new url, so active-reconcile (which matches the
    // `url` column) deactivates the old row and re-inserts a duplicate. Collapse to
    // a stable, still-navigable canonical keyed on company + req id so one job = one url.
    const m = u.pathname.match(/^\/(otp|leanyvallalatok)\/job\/.+\/(\d+)\/?$/);
    if (m) u.pathname = `/${m[1]}/job/${m[2]}/${m[2]}/`;
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

/* ── list page parser ────────────────────────────────────────── */

function extractJobLinks(html, baseUrl) {
  const $ = cheerioLoad(html);
  const links = new Set();

  // Each job tile has data-url="/otp/job/..." or "/leanyvallalatok/job/..."
  $("[data-url]").each((_, el) => {
    const raw = $(el).attr("data-url");
    if (!raw) return;
    try {
      const full = new URL(raw, baseUrl).toString();
      const path = new URL(full).pathname;
      if (path.startsWith("/otp/job/") || path.startsWith("/leanyvallalatok/job/")) {
        links.add(normalizeUrl(full));
      }
    } catch {
      // ignore malformed
    }
  });

  return [...links];
}

/* ── detail page parser ──────────────────────────────────────── */

// Detail HTML has only <title>"<jobtitle> Állás adatai | OTP Bank Nyrt."</title>
// (no usable <h1>); extract before the " Állás adatai" / " | " separator.
function extractTitle(html) {
  const $ = cheerioLoad(html);
  const h1 = normalizeWhitespace($("h1").first().text());
  if (h1 && h1.length >= 4) return h1;

  const raw = normalizeWhitespace($("title").first().text());
  if (!raw) return "";

  // strip " Állás adatai | OTP Bank Nyrt." style suffix
  let t = raw.replace(/\s*\|\s*OTP Bank.*$/i, "");
  t = t.replace(/\s*Állás adatai\s*$/i, "");
  return normalizeWhitespace(t);
}

/* ── db ──────────────────────────────────────────────────────── */

async function upsertJob(client, source, item) {
  const res = await client.query(
    `INSERT INTO job_posts (source, title, url, experience, first_seen)
     VALUES ($1,$2,$3,$4,NOW())
     ON CONFLICT (source, url) DO NOTHING
     RETURNING id;`,
    [source, item.title, item.url, item.experience ?? "-"]
  );
  return res.rowCount > 0;
}

/* ── handler ─────────────────────────────────────────────────── */

export default withTimeout("cron_jobs_OTP-background", async () => {
  _filters = await loadFilters();
  const client = await pool.connect();

  let listHtml;
  try {
    listHtml = await fetchText(LIST_URL);
  } catch (err) {
    await logFetchError("cron_jobs_OTP-background", { url: LIST_URL, message: err.message });
    console.error(`[otp] list fetch failed: ${err.message}`);
    client.release();
    return;
  }

  const jobLinks = extractJobLinks(listHtml, BASE);
  console.log(`[otp] list: ${jobLinks.length} links`);

  let newlyInserted = 0;
  let alreadyExisted = 0;
  let skippedSenior = 0;
  let skippedNoTitle = 0;
  let detailFetchFailed = 0;
  const foundUrls = [];

  try {
    for (const detailUrl of jobLinks) {
      try {
        await sleep(800);
        const html = await fetchText(detailUrl);
        const title = extractTitle(html);

        if (!title) {
          skippedNoTitle++;
          console.log(`[otp] SKIP no-title → ${detailUrl}`);
          continue;
        }

        if (isSeniorLike(title)) {
          skippedSenior++;
          console.log(`[otp] SKIP senior "${title}" → ${detailUrl}`);
          continue;
        }

        // OTP "Pályakezdő" list = adult entry-level IT jobs, not student interns.
        // Student OTP jobs are scraped separately by DIAK_3, so skip isInternshipTitle here
        // (it would falsely match "pályakezdő" in the title → "diákmunka").
        let experience;
        if (isJuniorTitle(title)) {
          experience = "junior";
        } else if (isMidLevelTitle(title)) {
          experience = "medior";
        } else {
          experience = extractBodyExperience(html) || "-";
        }

        const wasNew = await upsertJob(client, "otp", {
          title,
          url: detailUrl,
          experience,
        });
        foundUrls.push(detailUrl);

        if (wasNew) {
          newlyInserted++;
          console.log(`[otp] NEW "${title}" exp=${experience} → ${detailUrl}`);
        } else {
          alreadyExisted++;
          console.log(`[otp] EXISTS "${title}" → ${detailUrl}`);
        }
      } catch (err) {
        detailFetchFailed++;
        await logFetchError("cron_jobs_OTP-background", { url: detailUrl, message: err.message });
        console.error(`[otp] detail fetch failed ${detailUrl}: ${err.message}`);
      }
    }

    console.log(
      `[otp] DONE — total=${jobLinks.length}, new=${newlyInserted}, existed=${alreadyExisted}, ` +
      `skipped_senior=${skippedSenior}, skipped_no_title=${skippedNoTitle}, fetch_failed=${detailFetchFailed}`
    );

    const complete = detailFetchFailed === 0;
    const rc = await reconcileActive(client, "otp", foundUrls, { complete });
    console.log(`[otp] active reconcile — complete=${complete}, ${JSON.stringify(rc)}`);
  } finally {
    client.release();
  }
});
