export const config = {
  schedule: "14 6-22 * * *",
};


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
import { logFetchError, withTimeout } from "./_error-logger.mjs";

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

const INTERNSHIP_KEYWORDS = [
  "gyakornok", "intern", "internship", "trainee",
  "pályakezdő", "palyakezdo", "diákmunka", "diakmunka",
];
function isInternshipTitle(title) {
  const t = normalizeText(title);
  return INTERNSHIP_KEYWORDS.some(k => t.includes(k));
}

function normalizeWhitespace(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

function titleNotBlacklisted(title) {
  const t = normalizeText(title);
  return !_filters.some(word => t.includes(normalizeText(word)));
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
  const canonicalUrl = item.url;
  const experience = isInternshipTitle(item.title) ? "diákmunka" : "-";

  await client.query(
    `INSERT INTO job_posts
      (source, title, url, canonical_url, experience, first_seen)
     VALUES ($1,$2,$3,$4,$5,NOW())
     ON CONFLICT (source, canonical_url)
        DO NOTHING;
        `,
    [source, item.title, item.url, canonicalUrl, experience]
  );
}

function levelNotBlacklisted(title, desc) {
  const t = normalizeText(`${title ?? ""} ${desc ?? ""}`);
  return !_filters.some((w) => t.includes(normalizeText(w)));
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
  // Minden itemből: csak title, link
  return arr.map(it => ({
    title: it.title || null,
    url: it.link || null,
  }));
}

/* =========================
   BLACKLISTING
========================= 


 ---------------------
   Main (Netlify handler)
--------------------- */

export default withTimeout("cron_jobs_BLUE", async () => {
  _filters = await loadFilters();
  const SOURCES = [
    { key: "bluebird", label: "bluebird", url: "https://bluebird.hu/?feed=job_feed&search_location=Budapest&job_categories=devops-engineer" },
    { key: "bluebird", label: "bluebird", url: "https://bluebird.hu/?feed=job_feed&search_location=Budapest&job_categories=szoftverfejleszto-szoftvermernok" },
    { key: "bluebird", label: "bluebird", url: "https://bluebird.hu/?feed=job_feed&search_location=Budapest&job_categories=tesztelo" },
  ];
  const client = await pool.connect();
  try {
    for (const p of SOURCES) {
      let jobs = [];
      try {
        jobs = await fetchRssJobs(p.url);
        console.log(`${p.key}: ${jobs.length} jobs found in RSS.`);
      } catch (err) {
        await logFetchError("cron_jobs_BLUE", { url: p.url, message: err.message });
        console.error(p.key, "fetch failed:", err.message);
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
        try {
          await upsertJob(client, p.key, it);
        } catch (err) {
          console.error(err);
        }
      }
      console.log(`${p.key}: ${items.length} items processed.`);
    }
  } finally {
    client.release();
  }
  return new Response("OK");
});
