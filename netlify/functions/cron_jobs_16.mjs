export const config = {
  schedule: "20 4-23 * * *",
};

import { Pool } from "pg";
import https from "https";
import http from "http";
import zlib from "zlib";
import { XMLParser } from "fast-xml-parser";

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

function normalizeWhitespace(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

function titleNotBlacklisted(title) {
  const TITLE_BLACKLIST = [
    "marketing","sales","hr","finance","pénzügy","könyvelő",
    "accountant","manager","vezető","director","adminisztráció",
    "asszisztens","ügyfélszolgálat","customer service","call center",
    "értékesítő","bizto sítás","tanácsadó","biztosítás",
    "Adótanácsadó","Auditor","Accountant","Accounts","Tanácsadó",
     "senior",
    "szenior",
    "medior", "Villamosmérnök ", "ipari","Építészmérnök",
  "lead",
  "principal",
  "staff",
  "architect",
  "expert",
  "vezető fejlesztő",
  "tech lead"
  ];
  const t = normalizeText(title);
  return !TITLE_BLACKLIST.some(word => t.includes(normalizeText(word)));
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
        timeout: 50000,
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
  const $ = cheerioLoad(html);

  const items = [];
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    const url = new URL(href, baseUrl).toString();
    if (!/^https?:\/\//i.test(url)) return;

    let card = $(el).closest("article, li, .job-list-item, .job, .position, .listing, .card, .item");
    if (!card.length) card = $(el).closest("div");

    let title =
      normalizeWhitespace($(el).text()) ||
      normalizeWhitespace(card.find("h1,h2,h3,h4,h5,h6").first().text());
    if (!title || title.length < 4) return;

    const desc = normalizeWhitespace(card.find("p").first().text()) || null;
    items.push({ title: title.slice(0,300), url, description: desc ? desc.slice(0,800) : null });
  });
  return dedupeByUrl(items);
}

function getDedupeKey(rawUrl) {
  return normalizeUrl(rawUrl);
}


/* ---------------------
   DB upsert
--------------------- */
async function upsertJob(client, source, item) {
  const canonicalUrl = item.url;

  await client.query(
    `INSERT INTO job_posts
      (source, title, url, canonical_url, first_seen)
     VALUES ($1,$2,$3,$4,NOW())
     ON CONFLICT (source, canonical_url)
        DO NOTHING;
        `,
    [source, item.title, item.url, canonicalUrl]
  );
}

function levelNotBlacklisted(title, desc) {
  const LEVEL_BLACKLIST = [
    "medior", "senior", "szenior", "szernior", "lead", "principal", "expert",
    "staff", "architect", "sr.", "sr ", "sen.",
    "experienced", "expertise", "head"
  ];
  const t = normalizeText(`${title ?? ""} ${desc ?? ""}`);
  return !LEVEL_BLACKLIST.some(w => t.includes(normalizeText(w)));
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

export default async () => {
  const SOURCES = [
    { key: "bluebird", label: "bluebird", url: "https://bluebird.hu/?feed=job_feed&search_location=Budapest&job_categories=devops-engineer" },
    { key: "bluebird", label: "bluebird", url: "https://bluebird.hu/?feed=job_feed&search_location=Budapest&job_categories=szoftverfejleszto-szoftvermernok" },
    { key: "bluebird", label: "bluebird", url: "https://bluebird.hu/?feed=job_feed&search_location=Budapest&job_categories=tesztelo" },
    { key: "bluebird", label: "bluebird", url: "https://bluebird.hu/?feed=job_feed&search_location=Budapest&job_categories=it-architekt" },
  ];
  const client = await pool.connect();
  try {
    for (const p of SOURCES) {
      let jobs = [];
      try {
        jobs = await fetchRssJobs(p.url);
        console.log(`${p.key}: ${jobs.length} jobs found in RSS.`);
      } catch (err) {
        console.error(p.key, "fetch failed:", err.message);
        continue;
      }
      // Csak valós állások, senior/medior kizárás
      let items = jobs
        .filter(it => it.title && it.url)
        .filter(it => !levelNotBlacklisted(it.title, it.description))
        .filter(it => titleNotBlacklisted(it.title));
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
}
