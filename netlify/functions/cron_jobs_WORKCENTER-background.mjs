/*
  WorkCenter – informatikus kategória scraper

  Forrás: a taxonómia RSS feed
    https://workcenter.hu/munka-kategória/informatikus/feed/   (page N: ?paged=N)

  MIÉRT FEED, NEM HTML?
    A site Apache + IP-reputáció alapú WAF (nem Cloudflare, ahogy korábban
    feltételeztük). A HTML listaoldalakat és a /munka/ detail oldalakat a
    Netlify (AWS Lambda) datacenter IP-ről 403-mal tiltja. Lakossági IP-ről
    minden 200 — tehát NEM header-, hanem IP-szintű blokk, header-tuning nem segít.
    Az RSS feed más WP handler, amit a botvédelem kihagy → átmegy a Netlify IP-ről.
    A detail oldalak ugyanúgy blokkoltak, ezért NINCS detail-fetch: minden a feedből jön.

  Stratégia: FEED-ONLY
    - title:    item > title
    - url:      item > link  (/munka/{slug}/)
    - location: a feedben nincs strukturált location mező → a város a poszt
                törzsében (content:encoded) szerepel; Budapest-szűrés szövegből
    - experience: detectExperienceFromText(title, content:encoded) — title + törzsszöveg
                  kulcsszó-detektálás, detail oldal lekérés nélkül

  Flow:
    1. Fetch feed page=1,2,... — stop ha HTTP 404 (paged túl a végén) vagy 0 item
    2. item → title + link + content:encoded parse cheerio xmlMode-dal
    3. Budapest check a content szövegéből
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
// HTML list/detail pages are 403 from Netlify IPs (Apache IP-reputation WAF, not Cloudflare).
// The taxonomy RSS feed is a different handler that the WAF lets through. See header comment.
// WP REST API is not an option: /wp-json/wp/v2/job_listing → 404 (post type not REST-exposed).
const FEED_BASE = `${BASE}/munka-kateg%C3%B3ria/informatikus/feed`;

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
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
          "Accept-Language": "hu-HU,hu;q=0.9,en-US;q=0.8,en;q=0.7",
          "Accept-Encoding": "gzip, deflate, br",
          "Cache-Control": "max-age=0",
          "Connection": "keep-alive",
          "Upgrade-Insecure-Requests": "1",
          "Referer": "https://workcenter.hu/",
          "Sec-Fetch-Dest": "document",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Site": "same-origin",
          "Sec-Fetch-User": "?1",
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

/* ── experience from detail page ─────────────────────────────── */

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

// Experience comes straight from the feed's content:encoded — detail pages are
// IP-blocked from Netlify, so there is no detail fetch.

/* ── list page parser ────────────────────────────────────────── */

function extractJobEntries(xml) {
  const $ = cheerioLoad(xml, { xmlMode: true });
  const entries = [];
  let totalListings = 0;

  // RSS structure: rss > channel > item { title, link, content:encoded, description }
  $("item").each((_, item) => {
    totalListings++;

    const title = normalizeWhitespace($(item).find("title").first().text());
    const href = normalizeWhitespace($(item).find("link").first().text());
    if (!title || title.length < 2 || !href) return;

    // No structured location in the feed — the city lives in the post body.
    // content:encoded = full post HTML; fall back to <description> excerpt.
    // (css-select can't select the namespaced "content:encoded" tag, so scan children.)
    let content = "";
    $(item).children().each((_, c) => {
      if ((c.tagName || c.name || "").toLowerCase() === "content:encoded") content = $(c).text();
    });
    if (!content) content = $(item).find("description").first().text();

    // Budapest filter from body text (matches "Budapest", "Budapesti", … after accent strip)
    if (!normalizeText(`${title} ${content}`).includes("budapest")) return;

    const url = normalizeUrl(new URL(href, BASE).toString());
    entries.push({ title, url, content });
  });

  return { entries, totalListings };
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
  let fetchFailed = 0;

  try {
    const foundUrls = [];
    let page = 1;
    const MAX_PAGES = 10;

    while (page <= MAX_PAGES) {
      const listUrl =
        page === 1
          ? `${FEED_BASE}/`
          : `${FEED_BASE}/?paged=${page}`;

      let listHtml;
      try {
        await sleep(800);
        listHtml = await fetchText(listUrl);
      } catch (err) {
        if (err.message && err.message.includes("HTTP 404")) {
          if (page === 1) {
            fetchFailed++;
            await logFetchError("cron_jobs_WORKCENTER-background", { url: listUrl, message: err.message });
            console.error(`[workcenter] page 1 → 404, check URL`);
          } else {
            console.log(`[workcenter] page ${page} → 404, no more pages`);
          }
          break;
        }
        fetchFailed++;
        await logFetchError("cron_jobs_WORKCENTER-background", { url: listUrl, message: err.message });
        console.error(`[workcenter] list page ${page} fetch failed: ${err.message}`);
        break;
      }

      const { entries, totalListings } = extractJobEntries(listHtml);
      console.log(`[workcenter] page ${page} → ${entries.length} Budapest IT jobs (${totalListings} total listings)`);

      if (totalListings === 0) {
        // Truly empty page — no more pages
        if (page === 1) console.warn("[workcenter] page 1 returned 0 listings — check selector or URL");
        break;
      }

      if (entries.length === 0) {
        // Page has jobs but none from Budapest — keep paginating
        console.log(`[workcenter] page ${page} → skipping (no Budapest jobs on this page)`);
        page++;
        continue;
      }

      for (const entry of entries) {
        if (isSeniorLike(entry.title)) {
          skippedSenior++;
          console.log(`[workcenter] SKIP senior "${entry.title}"`);
          continue;
        }

        // Title-based internship marker takes priority, then text-based detection.
        const experience = isInternshipTitle(entry.title)
          ? "diákmunka"
          : detectExperienceFromText(entry.title, entry.content);

        const wasNew = await upsertJob(client, "workcenter", {
          title: entry.title,
          url: entry.url,
          experience,
        });
        foundUrls.push(entry.url);
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

    const complete = fetchFailed === 0;
    const rc = await reconcileActive(client, "workcenter", foundUrls, { complete });
    console.log(`[workcenter] active reconcile — complete=${complete}, ${JSON.stringify(rc)}`);
  } finally {
    client.release();
  }
});
