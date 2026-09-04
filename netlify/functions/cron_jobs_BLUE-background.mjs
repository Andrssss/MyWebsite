
/* =========================
const SOURCES = [
    { key: "bluebird", label: "bluebird", url: "https://bluebird.hu/?feed=job_feed&search_location=Budapest&job_categories=devops-engineer" },
    { key: "bluebird", label: "bluebird", url: "https://bluebird.hu/?feed=job_feed&search_location=Budapest&job_categories=szoftverfejleszto-szoftvermernok" },
    { key: "bluebird", label: "bluebird", url: "https://bluebird.hu/?feed=job_feed&search_location=Budapest&job_categories=tesztelo" },
  ];
--------------------- */

import { Pool } from "pg";
import https from "https";
import http from "http";
import zlib from "zlib";
import { XMLParser } from "fast-xml-parser";
import { loadFilters } from "./load_filters.mjs";
import { withTimeout } from "./_error-logger.mjs";
import { reconcileActive } from "./_active_core.mjs";
import { INTERNSHIP_KEYWORDS, isInternshipTitle, isJuniorTitle, isMidLevelTitle, extractBluebirdExperience, extractTechnologies, isSeniorExperience } from "./_experience_core.mjs";
import { shouldSkipTitleFilter, shouldSkipSeniorExperience, seniorAwareExperience } from "./_seniority_policy.mjs";
import { computeLevel } from "../../src/lib/experienceLevel.mjs";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let _filters = [];

/* ---------------------
   DB connection
--------------------- */
const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

/* ---------------------
   Helper functions
--------------------- */
function normalizeText(s) {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// INTERNSHIP_KEYWORDS / isInternshipTitle imported from _experience_core.mjs

function normalizeWhitespace(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

function _blacklistRegex(k) {
  const escaped = normalizeText(k).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i");
}

function titleNotBlacklisted(title) {
  return !shouldSkipTitleFilter(title, _filters);
}

function dedupeByUrl(items) {
  const seen = new Set();
  return items.filter((x) => {
    if (!x.url) return false;
    const key = getDedupeKey(x.url);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/* =====================
   URL helpers
===================== */
function normalizeUrl(raw) {
  try {
    const u = new URL(raw);

    u.hash = "";
    [
      "utm_source","utm_medium","utm_campaign","utm_term",
      "utm_content","fbclid","gclid","trackingId","pageNum","position","refId"
    ].forEach(p => u.searchParams.delete(p));

    return u.toString().replace(/\?$/, "");
  } catch {
    return raw;
  }
}

/* ---------------------
   Fetch helper
--------------------- */
function fetchText(url, redirectLeft = 5) {
  return new Promise((resolve, reject) => {
    console.log(`Script started at ${new Date().toISOString()}`);
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;

    const req = lib.request(
      u,
      {
        method: "GET",
        headers: {
          "User-Agent": "JobWatcher/1.0",
          Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
          "Accept-Language": "hu-HU,hu;q=0.9,en;q=0.8",
          "Accept-Encoding": "gzip,deflate,br",
        },
        timeout: 25000,
      },
      (res) => {
        const code = res.statusCode || 0;

        if ([301,302,303,307,308].includes(code)) {
          const loc = res.headers.location;
          if (!loc) return reject(new Error(`HTTP ${code} (no Location) for ${url}`));
          if (redirectLeft <= 0) return reject(new Error(`Too many redirects for ${url}`));
          const nextUrl = new URL(loc, url).toString();
          res.resume();
          return resolve(fetchText(nextUrl, redirectLeft - 1));
        }

        const enc = String(res.headers["content-encoding"] || "").toLowerCase();
        let stream = res;
        if (enc.includes("gzip")) stream = res.pipe(zlib.createGunzip());
        else if (enc.includes("deflate")) stream = res.pipe(zlib.createInflate());
        else if (enc.includes("br")) stream = res.pipe(zlib.createBrotliDecompress());

        let data = "";
        stream.setEncoding("utf8");
        stream.on("data", (chunk) => data += chunk);
        stream.on("end", () => {
          if (code >= 200 && code < 300) resolve(data);
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

/* ---------------------
   HTML extraction
--------------------- */
function extractCandidates(html, baseUrl) {
  // ...existing code...
}

function getDedupeKey(rawUrl) {
  return normalizeUrl(rawUrl);
}

/* ---------------------
   DB upsert
--------------------- */
async function upsertJob(client, source, item) {
  // Insert-only, kivétel nélkül (user-szabály, LinkedInen kívül sehol nincs
  // utólagos UPDATE): a sor insert előtt épül fel teljesen, a konfliktus
  // esetén a meglévő sor változatlan marad.
  const experience = seniorAwareExperience(item.title, item.experience);
  await client.query(
    `INSERT INTO job_posts
      (source, title, url, experience, company, technologies, level, first_seen)
     VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
     ON CONFLICT (source, url) DO NOTHING;`,
    [source, item.title, item.url, experience, item.company || null, item.technologies ?? null, computeLevel({ title: item.title, experience, source })]
  );
}

function levelNotBlacklisted(title, desc) {
  return !shouldSkipTitleFilter(title, _filters);
}

// XMLParser-érték → trimmelt szöveg (CDATA sima stringként jön; attribútumos
// node esetén objektum lenne, abból a #text kell)
function xmlText(v) {
  if (v == null) return null;
  if (typeof v === "object") v = v["#text"] ?? "";
  const s = String(v).trim();
  return s || null;
}

// Bluebird RSS feldolgozó
async function fetchRssJobs(url) {
  const xml = await fetchText(url);
  const parser = new XMLParser({ ignoreAttributes: false });
  const feed = parser.parse(xml);
  // Az RSS feed szerkezete: feed.rss.channel.item vagy feed.channel.item
  const items =
    (feed.rss && feed.rss.channel && feed.rss.channel.item) ||
    (feed.channel && feed.channel.item) ||
    [];
  // Ha csak egy item van, akkor nem tömb, hanem objektum
  const arr = Array.isArray(items) ? items : [items];
  // Minden itemből: title, link, company (a feedben ma minden item cége
  // "Bluebird" — az ügyfél anonim, de ha valaha kiírják, magától bejön)
  return arr.map(it => ({
    title: it.title || null,
    url: it.link || null,
    company: xmlText(it["job_listing:company"]),
  }));
}

/* =========================
   BLACKLISTING
========================= 


 ---------------------
   Main (Netlify handler)
--------------------- */

const _runJob = withTimeout("cron_jobs_BLUE-background", async (request) => {
  _filters = await loadFilters();
  const SOURCES = [
    { key: "bluebird", label: "bluebird", url: "https://bluebird.hu/?feed=job_feed&search_location=Budapest&job_categories=devops-engineer" },
    { key: "bluebird", label: "bluebird", url: "https://bluebird.hu/?feed=job_feed&search_location=Budapest&job_categories=szoftverfejleszto-szoftvermernok" },
    { key: "bluebird", label: "bluebird", url: "https://bluebird.hu/?feed=job_feed&search_location=Budapest&job_categories=tesztelo" },
  ];
  const client = await pool.connect();
  try {
    // Only a genuinely NEW url needs its own detail-page fetch for experience —
    // an already-known row is already complete and ON CONFLICT DO NOTHING would
    // discard the fetch anyway.
    const { rows: knownRows } = await client.query(
      `SELECT url FROM job_posts WHERE source = 'bluebird'`
    );
    const known = new Set(knownRows.map((r) => r.url));

    const foundUrls = [];
    let crawlError = false;
    for (const p of SOURCES) {
      let jobs = [];
      try {
        jobs = await fetchRssJobs(p.url);
        console.log(`${p.key}: ${jobs.length} jobs found in RSS.`);
      } catch (err) {
        console.error(p.key, "fetch failed:", err.message);
        crawlError = true;
        continue;
      }
      // Csak valós állások, senior/medior kizárás
      let items = [];
      for (const it of jobs) {
        if (!it.title || !it.url) {
          console.log(`SKIP: missing title or url:`, it);
          continue;
        }
        if (!it.url.startsWith("https://bluebird.hu/it-allasok-es-it-projektek/")) {
          console.log(`SKIP: url not bluebird projektek:`, it.url);
          continue;
        }
        let blacklisted = false;
        if (!titleNotBlacklisted(it.title)) {
          blacklisted = true;
        }
        // description mező már nincs, de a levelNotBlacklisted még hívja, ezért átadunk üres stringet
        if (!levelNotBlacklisted(it.title, "")) {
          blacklisted = true;
        }
        if (!blacklisted) {
          items.push(it);
        }
      }
      for (const it of items) {
        // Build the row COMPLETE before it's ever inserted — no separate pass
        // comes back later to patch experience/technologies in. A cím-alapú szint
        // gyakran feloldja az experience-t, de a technologies KIZÁRÓLAG a
        // detail-oldalról jön, ezért a fetch új állásnál mindig lefut — az
        // experience-t csak akkor írjuk felül, ha a cím még nem oldotta fel.
        it.experience = isInternshipTitle(it.title) ? "diákmunka"
          : isJuniorTitle(it.title) ? "junior"
          : isMidLevelTitle(it.title) ? "medior"
          : "-";
        if (!known.has(it.url)) {
          try {
            await sleep(500);
            const detailHtml = await fetchText(it.url);
            if (it.experience === "-") it.experience = extractBluebirdExperience(detailHtml) || "-";
            it.technologies = extractTechnologies(detailHtml);
          } catch (err) {
            console.warn(`[bluebird] detail fetch failed: ${it.url} — ${err.message}`);
          }
        }
        if (shouldSkipSeniorExperience(isSeniorExperience(it.experience))) {
          console.log(`SKIP senior exp="${it.experience}" "${it.title}"`);
          continue;
        }
        try {
          await upsertJob(client, p.key, it);
        } catch (err) {
          console.error(err);
        }
        foundUrls.push(it.url);
      }
      console.log(`${p.key}: ${items.length} items processed.`);
    }

    // RSS feed only returns latest N items — absence proves nothing, so
    // deactivation stays with the daily sweep's banner rule
    // (BANNER_DEAD_SOURCES.bluebird). Presence DOES prove the posting is live,
    // so run a reactivate-only reconcile (complete:false, nofluffjobs pattern):
    // without it a false sweep verdict was permanent — nothing ever set
    // active=true again on a re-seen row.
    const rc = await reconcileActive(client, "bluebird", foundUrls, { complete: false });
    console.log(`[bluebird] reactivate-only reconcile — ${JSON.stringify(rc)}`);
  } finally {
    client.release();
  }

  return new Response("OK");
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

