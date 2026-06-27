/*
  WorkCenter – informatikus kategória scraper

  Forrás: WordPress REST API
    https://workcenter.hu/wp-json/wp/v2/job-listings?job-categories=755&per_page=100&page=N
    (755 = "informatikus" job-category term id; lekérve a /wp/v2/job-categories?slug=informatikus-ból)

  MIÉRT REST, NEM FEED/HTML?
    A site Apache + IP-reputáció alapú WAF (nem Cloudflare). A Netlify (AWS Lambda)
    datacenter IP-ről a HTML lista/detail oldalakat 403-mal tiltja. Lakossági IP-ről
    minden 200 — tehát IP-szintű blokk, header-tuning NEM segít.
    Korábban az RSS feed (más WP handler) átment a Netlify IP-ről, de a WAF ezt is
    elkezdte 403-azni. A WP REST API (/wp-json/wp/v2/...) megint másik handler —
    erre váltottunk. A logból derül ki, hogy átmegy-e: ha "page 1 → N IT listings"
    jön, működik; ha a wp-json/... is 403, akkor a blokk már ÁLTALÁNOS (minden path).

    DIAGNOSZTIKA (2026-06-27): lakossági IP-ről MINDEN endpoint 200 (feed, HTML,
    /wp-json/...), Netlify datacenter IP-ről 403. Tehát IP-szintű blokk —
    header/User-Agent tuning BIZTOSAN nem segít, ne is próbáld.

    HA A REST IS 403 NETLIFY-RÓL, a lehetőségek (sorrendben):
      1. Proxy / scraping-szolgáltatás (ScraperAPI, ScrapingBee, Bright Data) —
         lakossági / nem-datacenter IP-ről kéri le helyettünk; kell hozzá API kulcs.
      2. Ezt az egy scrapert nem-datacenter hostról futtatni.
      3. Elengedni a workcentert.
    A _company_name itt MINDIG "WORKCENTER Személyzeti Tanácsadó" (a kölcsönző saját
    neve, nem a tényleges munkáltató), ezért céget NEM mentünk.

  Stratégia: REST-ONLY (nincs detail-fetch, minden a list endpointból jön)
    - title:    item.title.rendered
    - url:      item.link  (/munka/{slug}/)
    - location: item.meta._job_location → Budapest-szűrés
    - content:  item.content.rendered → experience kulcsszó-detektálás
    - company:  item.meta._company_name MINDIG "WORKCENTER Személyzeti Tanácsadó"
                (a kölcsönző saját neve, nem a tényleges munkáltató) → NEM mentjük.

  Flow:
    1. GET REST page=1,2,… (per_page=100) — stop ha üres oldal / <per_page / HTTP 400
    2. item → title + link + location + content
    3. Budapest check a _job_location mezőből (üresnél body-fallback)
    4. isSeniorLike filter
    5. Upsert (source = "workcenter")
*/

import { Pool } from "pg";
import https from "https";
import http from "http";
import zlib from "zlib";
import { load as cheerioLoad } from "cheerio";
import { loadFilters } from "./load_filters.mjs";
import { logFetchError, withTimeout } from "./_error-logger.mjs";
import { reconcileActive } from "./_active_core.mjs";
import { isInternshipTitle, extractYearsFromText } from "./_experience_core.mjs";

let _filters = [];

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

const BASE = "https://workcenter.hu";
// HTML list/detail pages and the RSS feed are 403 from Netlify IPs (Apache IP-reputation WAF).
// The WP REST API is a different handler — see header comment.
const API_BASE = `${BASE}/wp-json/wp/v2/job-listings`;
const IT_CATEGORY_ID = 755; // "informatikus" term id
const PER_PAGE = 100;
const MAX_PAGES = 10;

/* ── helpers ─────────────────────────────────────────────────── */

function normalizeWhitespace(v) {
  return String(v ?? "").replace(/\s+/g, " ").trim();
}

function normalizeText(v) {
  return String(v ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function htmlToText(html) {
  if (!html) return "";
  return normalizeWhitespace(cheerioLoad(`<div>${html}</div>`).text());
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
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "Accept": "application/json,text/html;q=0.9,*/*;q=0.8",
          "Accept-Language": "hu-HU,hu;q=0.9,en-US;q=0.8,en;q=0.7",
          "Accept-Encoding": "gzip, deflate, br",
          "Cache-Control": "max-age=0",
          "Connection": "keep-alive",
          "Referer": "https://workcenter.hu/",
          "Sec-Fetch-Dest": "empty",
          "Sec-Fetch-Mode": "cors",
          "Sec-Fetch-Site": "same-origin",
          "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
          "sec-ch-ua-mobile": "?0",
          "sec-ch-ua-platform": '"Windows"',
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

async function fetchJson(url) {
  const body = await fetchText(url);
  return JSON.parse(body);
}

/* ── experience from listing text ────────────────────────────── */

const INTERN_TEXT_KEYWORDS = [
  "gyakornok", "intern", "internship", "trainee",
  "pályakezdő", "palyakezdo", "diákmunka", "diakmunka",
  "tehetségprogram", "tehetsegprogram",
  "friss diplomás", "friss diplomas",
  "nem szükséges tapasztalat", "tapasztalat nem szükséges",
  "tapasztalat nélkül", "tapasztalat nelkul",
  "belépő szintű", "belepo szintu",
];

function detectExperienceFromText(title, descText) {
  const t = normalizeText(title);
  const d = normalizeText(descText ?? "");
  const combined = t + " " + d;

  // 1. Internship/entry markers take priority
  if (INTERN_TEXT_KEYWORDS.some(k => combined.includes(normalizeText(k)))) return "diákmunka";

  // 2. Extract year-based experience from description
  const years = extractYearsFromText(descText ?? "");
  if (years) return years;

  return "-";
}

/* ── listing parser ──────────────────────────────────────────── */

function isBudapest(location, title, content) {
  const loc = normalizeText(location);
  if (loc) return loc.includes("budapest");
  // No structured location → fall back to body text.
  return normalizeText(`${title} ${content}`).includes("budapest");
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

export default withTimeout("cron_jobs_WORKCENTER-background", async () => {
  _filters = await loadFilters();
  const client = await pool.connect();

  let newlyInserted = 0;
  let alreadyExisted = 0;
  let skippedSenior = 0;
  let skippedNonBudapest = 0;
  let fetchFailed = 0;

  try {
    // Timing-jitter: a cron mindig ugyanakkor fut, ami szabályos mintát ad a forrásnak.
    // Egy random várakozás eltolja a kérés idejét. (Megj.: a 403 a mérések szerint
    // IP-alapú — lásd a header-kommentet —, ezt a jitter valószínűleg NEM oldja meg,
    // de ártalmatlan és olcsó kipróbálni.)
    const jitterMs = Math.floor(Math.random() * 30000); // 0–30 s
    console.log(`[workcenter] timing jitter: várok ${Math.round(jitterMs / 1000)} s`);
    await sleep(jitterMs);

    const foundUrls = [];
    let page = 1;

    while (page <= MAX_PAGES) {
      const apiUrl =
        `${API_BASE}?job-categories=${IT_CATEGORY_ID}&per_page=${PER_PAGE}` +
        `&page=${page}&_fields=id,link,title,content,meta`;

      let listings;
      try {
        await sleep(500);
        listings = await fetchJson(apiUrl);
      } catch (err) {
        // WP returns HTTP 400 (rest_post_invalid_page_number) past the last page.
        if (/HTTP 400/.test(err.message) && page > 1) {
          console.log(`[workcenter] page ${page} → 400 (past last page), done`);
          break;
        }
        fetchFailed++;
        await logFetchError("cron_jobs_WORKCENTER-background", { url: apiUrl, message: err.message });
        console.error(`[workcenter] page ${page} fetch failed: ${err.message}`);
        break;
      }

      if (!Array.isArray(listings) || listings.length === 0) {
        if (page === 1) console.warn("[workcenter] page 1 returned 0 listings — check category id or API");
        break;
      }

      console.log(`[workcenter] page ${page} → ${listings.length} IT listings`);

      for (const item of listings) {
        const title = htmlToText(item?.title?.rendered);
        const href = item?.link;
        if (!title || title.length < 2 || !href) continue;

        const location = item?.meta?._job_location ?? "";
        const content = htmlToText(item?.content?.rendered);

        if (!isBudapest(location, title, content)) {
          skippedNonBudapest++;
          continue;
        }

        if (isSeniorLike(title)) {
          skippedSenior++;
          console.log(`[workcenter] SKIP senior "${title}"`);
          continue;
        }

        const url = normalizeUrl(new URL(href, BASE).toString());

        // Title-based internship marker takes priority, then text-based detection.
        const experience = isInternshipTitle(title)
          ? "diákmunka"
          : detectExperienceFromText(title, content);

        const wasNew = await upsertJob(client, "workcenter", { title, url, experience });
        foundUrls.push(url);
        if (wasNew) {
          newlyInserted++;
          console.log(`[workcenter] NEW "${title}" → ${url}`);
        } else {
          alreadyExisted++;
          console.log(`[workcenter] EXISTS "${title}"`);
        }
      }

      if (listings.length < PER_PAGE) break;
      page++;
    }

    console.log(
      `[workcenter] DONE — new=${newlyInserted}, existed=${alreadyExisted}, ` +
      `skipped_senior=${skippedSenior}, skipped_non_budapest=${skippedNonBudapest}, fetch_failed=${fetchFailed}`
    );

    const complete = fetchFailed === 0;
    const rc = await reconcileActive(client, "workcenter", foundUrls, { complete });
    console.log(`[workcenter] active reconcile — complete=${complete}, ${JSON.stringify(rc)}`);
  } finally {
    client.release();
  }
});
