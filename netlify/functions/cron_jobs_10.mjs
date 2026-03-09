export const config = {
  schedule: "1 4-23 * * *",
};

import { Pool } from "pg";
import https from "https";
import http from "http";
import zlib from "zlib";
import { load as cheerioLoad } from "cheerio";

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    "medior", "Villamosmérnök ",
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

function matchesKeywords(title, desc) {
  const KEYWORDS_STRONG = [
    "gyakornok","intern","internship","trainee","junior","c++","java","python","web",
    "developer","fejlesztő","fejleszto","data","analyst","tesztelő",
    "support","operations","qa","tester","sysadmin","network","devops","automation","automatizalo"
  ];
  const n = normalizeText(`${title ?? ""} ${desc ?? ""}`);
  const strongHit = KEYWORDS_STRONG.some(k => n.includes(normalizeText(k)));
  const itHit = /\bit\b/i.test(n);
  return strongHit || (
    itHit &&
    /support|sysadmin|network|qa|tester|developer|data|analyst|operations|security|biztonsag|tanacsado|consultant/.test(n)
  );
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

function extractExperienceFromHtml(html) {
  const $ = cheerioLoad(html);
  const pageText = normalizeWhitespace($("body").text());
  if (!pageText) return null;

  const patterns = [
    /\b\d+\s?\+\s?(?:ev|eves|év|éves|years?|yrs?)\b/gi,
    /\b\d+\s?(?:-\s?\d+)?\s?(?:ev|eves|év|éves|years?|yrs?)\b/gi,
    /\bminimum\s?\d+\s?(?:ev|eves|év|éves|years?|yrs?)\b/gi,
    /\bat least\s?\d+\s?(?:years?)\b/gi,
  ];

  const matches = [];
  for (const regex of patterns) {
    const found = pageText.match(regex);
    if (found) matches.push(...found);
  }

  if (!matches.length) return null;

  const maxReasonable = 15;
  const filtered = matches.filter((m) => {
    const nums = m.match(/\d+/g)?.map((n) => parseInt(n, 10)) || [];
    return nums.every((n) => n <= maxReasonable);
  });

  if (!filtered.length) return null;

  return [...new Set(filtered.map((m) => m.replace(/\s+/g, " ").trim().toLowerCase()))].join(", ");
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
    "experienced", "expertise"
  ];
  const t = normalizeText(`${title ?? ""} ${desc ?? ""}`);
  return !LEVEL_BLACKLIST.some(w => t.includes(normalizeText(w)));
}

const YETTEL_JOB_PREFIX = "https://jobs.ceetelcogroup.com/yettel/job/";
const AAM_JOB_PREFIX = "https://aam.hu/allasajanlatok";
const KARRIERHUNGARIA_JOB_PREFIX = "https://karrierhungaria.hu/allasajanlat";
const FRISSDIPLOMAS_JOB_PREFIX = "https://www.frissdiplomas.hu/allasok";

/* =========================
   BLACKLISTING
========================= 
const BLACKLIST_SOURCES = ["profession"];

const BLACKLIST_URLS = [
  "https://www.profession.hu/allasok/it-programozas-fejlesztes/budapest/1,10,23,internship",
  "https://www.profession.hu/allasok/it-uzemeltetes-telekommunikacio/budapest/1,25,23,gyakornok,0,0,0,0,0,0,0,0,0,10",
  "https://www.profession.hu/allasok/it-uzemeltetes-telekommunikacio/budapest/1,25,23,internship"
];

 ---------------------
   Main (Netlify handler)
--------------------- */
export default async () => {
  



const SOURCES = [
  { key: "yettel", label: "yettel", url: "https://www.yettel.hu/karrier/it" },  // https://jobs.ceetelcogroup.com/yettel/job/T%C3%B6r%C3%B6kb%C3%A1lint-Junior-Business-Analyst-2045/1144278955/
  { key: "karrierhungaria", label: "karrierhungaria", url: "https://karrierhungaria.hu/allasajanlatok/it-programozas-fejlesztes/budapest?em[]=1" },
  { key: "karrierhungaria", label: "karrierhungaria", url: "https://karrierhungaria.hu/allasajanlatok/it-uzemeltetes-telekommunikacio/budapest?em[]=1" },
  { key: "aam", label: "aam", url: "https://aam.hu/karrier" },
  { key: "aam", label: "aam", url: "https://aam.hu/allasajanlatok" },
  { key: "frissdiplomas", label: "frissdiplomas", url: "https://www.frissdiplomas.hu/allasok" },
];

  const client = await pool.connect();

  try {
    for (const p of SOURCES) {
      let html;
      try {
        html = await fetchText(p.url);
      } catch (err) {
        console.error(p.key, "fetch failed:", err.message);
        continue;
      }

      const rawItems = extractCandidates(html, p.url);

      let items = rawItems.filter(it => {
        if (p.key === "yettel" && !it.url.startsWith(YETTEL_JOB_PREFIX)) return false;
        if (p.key === "aam" && !it.url.startsWith(AAM_JOB_PREFIX)) return false;
        if (p.key === "karrierhungaria" && !it.url.startsWith(KARRIERHUNGARIA_JOB_PREFIX)) return false;
        if (p.key === "frissdiplomas" && !it.url.startsWith(FRISSDIPLOMAS_JOB_PREFIX)) return false;
        const needKeywords = p.key === "cvonline";
        if (needKeywords && !matchesKeywords(it.title, it.description)) return false;
        if (!levelNotBlacklisted(it.title, it.description)) return false;
        if (!titleNotBlacklisted(it.title)) return false;
        return true;
      });

     // items = applyBlacklist(items, p.key);

      for (const it of items) {
        try {
          await upsertJob(client, p.key, it);
        } catch (err) {
          console.error(err);
        }
      }

      console.log(`${p.key}: ${items.length} items processed.`);
    }

    const sourceKeys = [...new Set(SOURCES.map((s) => s.key))];
    const { rows: enrichRows } = await client.query(
      `SELECT id, url
       FROM job_posts
       WHERE first_seen >= NOW() - INTERVAL '10 minutes'
         AND (experience IS NULL OR experience = '-')
         AND source = ANY($1::text[])
       ORDER BY first_seen DESC
       LIMIT 300`,
      [sourceKeys]
    );

    for (const row of enrichRows) {
      try {
        const detailHtml = await fetchText(row.url);
        const experience = extractExperienceFromHtml(detailHtml);

        if (experience) {
          await client.query(
            `UPDATE job_posts
             SET experience = $1
             WHERE id = $2`,
            [experience, row.id]
          );
        }

        await sleep(200);
      } catch (err) {
        console.error("enrichment failed:", row.id, err.message);
      }
    }
  } finally {
    console.log(`Script started at ${new Date().toISOString()}`);
    client.release();
  }

  return new Response("OK");
};
