/*
  WorkCenter – informatikus kategória scraper

  List URL:
    https://workcenter.hu/jobs/?filter_job_listing_category=informatikus
    https://workcenter.hu/jobs/page/{N}/?filter_job_listing_category=informatikus

  ⚠️ KRITIKUS KORLÁT: A detail oldalak (/munka/{slug}/) raw HTTP GET-tel
  Google Maps-re irányítanak vissza (valószínűleg JS-alapú redirect).
  A detail oldal tartalma headless browser nélkül nem érhető el.

  Stratégia: LISTING-ONLY
    - Az anchor szövegből nyerjük a title-t és a helyszínt
    - Budapest check az anchor szövegből (kötelező — a kategória nem Budapest-specifikus)
    - experience = "-" mindig (detail nem elérhető)
    - url = az anchor href (canonical_url = ugyanaz)

  Anchor szöveg formátuma:
    "{CÉGNÉV}  {JOB CÍM}  {HELYSZÍN}"
    pl. "WORKCENTER Személyzeti Tanácsadó HÁLÓZATI TECHNIKUS  Budapest, XI. kerület"

  Flow:
    1. Fetch listing pages page=1,2,... — stop ha nincs /munka/ link
    2. Budapest check az anchor szöveg helyszín részéből
    3. Title parse az anchor szövegből
    4. isSeniorLike filter
    5. Upsert (source = "workcenter", experience = "-")
*/

import { Pool } from "pg";
import https from "https";
import http from "http";
import zlib from "zlib";
import { load as cheerioLoad } from "cheerio";
import { loadFilters } from "./load_filters.mjs";
import { logFetchError, withTimeout } from "./_error-logger.mjs";
import { isInternshipTitle } from "./_experience_core.mjs";

let _filters = [];

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

const BASE = "https://workcenter.hu";
const LIST_BASE = `${BASE}/jobs`;
const CATEGORY_PARAM = "filter_job_listing_category=informatikus";

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

// Anchor href: /munka/{slug}/  or  /?post_type=job_listing&p={ID}
const JOB_HREF_RE = /^\/munka\/[^/?#]+\/?$|^\/?(?:\?.*)?post_type=job_listing/;

function extractJobEntries(html) {
  const $ = cheerioLoad(html);
  const entries = [];

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    let path;
    try {
      path = new URL(href, BASE).pathname;
    } catch {
      return;
    }

    // Only job links
    if (!href.includes("/munka/") && !href.includes("post_type=job_listing")) return;
    if (!JOB_HREF_RE.test(href) && !JOB_HREF_RE.test(path)) return;

    const rawText = normalizeWhitespace($(el).text());
    if (!rawText || rawText.length < 5) return;

    // Anchor format: "{COMPANY}  {TITLE}  {LOCATION}"
    // Split on double-space
    const parts = rawText.split(/  +/);

    let title = "";
    let location = "";

    if (parts.length >= 3) {
      // parts[0] = company name, parts[1] = title, parts[last] = location
      title = normalizeWhitespace(parts.slice(1, parts.length - 1).join(" "));
      location = normalizeWhitespace(parts[parts.length - 1]);
    } else if (parts.length === 2) {
      title = normalizeWhitespace(parts[0]);
      location = normalizeWhitespace(parts[1]);
    } else {
      // No double-space — try known prefix removal
      const m = rawText.match(
        /^(?:WORKCENTER\s+Személyzeti\s+Tanácsadó|Work4You)\s+(.+)$/i
      );
      title = m ? normalizeWhitespace(m[1]) : rawText;
    }

    if (!title || title.length < 2) return;

    // Budapest check
    if (!location.toLowerCase().includes("budapest") &&
        !rawText.toLowerCase().includes("budapest")) return;

    const url = normalizeUrl(new URL(href, BASE).toString());
    entries.push({ title, url });
  });

  return entries;
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

export default withTimeout("cron_jobs_WORKCENTER-background", async () => {
  _filters = await loadFilters();
  const client = await pool.connect();

  let newlyInserted = 0;
  let alreadyExisted = 0;
  let skippedSenior = 0;
  let fetchFailed = 0;

  try {
    let page = 1;

    while (true) {
      const listUrl =
        page === 1
          ? `${LIST_BASE}/?${CATEGORY_PARAM}`
          : `${LIST_BASE}/page/${page}/?${CATEGORY_PARAM}`;

      let listHtml;
      try {
        await sleep(800);
        listHtml = await fetchText(listUrl);
      } catch (err) {
        fetchFailed++;
        await logFetchError("cron_jobs_WORKCENTER-background", { url: listUrl, message: err.message });
        console.error(`[workcenter] list page ${page} fetch failed: ${err.message}`);
        break;
      }

      const entries = extractJobEntries(listHtml);
      console.log(`[workcenter] page ${page} → ${entries.length} Budapest IT jobs`);

      if (entries.length === 0) {
        // Could be empty page or no more pages
        if (page === 1) {
          console.warn("[workcenter] page 1 returned 0 entries — check selector");
        }
        break;
      }

      for (const entry of entries) {
        if (isSeniorLike(entry.title)) {
          skippedSenior++;
          console.log(`[workcenter] SKIP senior "${entry.title}"`);
          continue;
        }

        const experience = isInternshipTitle(entry.title) ? "diákmunka" : "-";

        const wasNew = await upsertJob(client, "workcenter", {
          title: entry.title,
          url: entry.url,
          experience,
        });
        if (wasNew) {
          newlyInserted++;
          console.log(`[workcenter] NEW "${entry.title}" → ${entry.url}`);
        } else {
          alreadyExisted++;
          console.log(`[workcenter] EXISTS "${entry.title}"`);
        }
      }

      page++;
    }

    console.log(
      `[workcenter] DONE — new=${newlyInserted}, existed=${alreadyExisted}, ` +
      `skipped_senior=${skippedSenior}, fetch_failed=${fetchFailed}`
    );
  } finally {
    client.release();
  }
});
