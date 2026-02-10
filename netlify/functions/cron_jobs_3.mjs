export const config = {
  schedule: "1 4,16 * * *",
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

function titleNotBlacklisted(title) {
  const TITLE_BLACKLIST = [
    "marketing","sales","hr","finance","pénzügy","könyvelő",
    "accountant","manager","vezető","director","adminisztráció",
    "asszisztens","ügyfélszolgálat","customer service","call center",
    "értékesítő","bizto sítás","tanácsadó","biztosítás",
    "Adótanácsadó","Auditor","Accountant","Accounts","Tanácsadó"
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

    if (u.hostname.includes("linkedin.com") && u.pathname.startsWith("/jobs/view/")) {
      u.search = "";
      u.hash = "";
      return u.toString();
    }

    u.hash = "";
    [
      "utm_source","utm_medium","utm_campaign","utm_term",
      "utm_content","fbclid","gclid"
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

/* ---------------------
   LinkedIn extraction
--------------------- */
function extractLinkedInJobs(html) {
  const $ = cheerioLoad(html);
  const jobs = [];

  $("ul.jobs-search__results-list li").each((_, el) => {
    const title = normalizeText($(el).find("h3.base-search-card__title").text());
    const company = normalizeText($(el).find("h4.base-search-card__subtitle").text());
    const location = normalizeText($(el).find("span.job-search-card__location").text());
    const url = $(el).find("a.base-card__full-link").attr("href");
    if (title && url) jobs.push({ title, url, company, location });
  });

  return dedupeByUrl(jobs);
}

function canonicalizeLinkedInJobUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.hostname.includes("linkedin.com") && u.pathname.startsWith("/jobs/view/")) {
      const lastPart = u.pathname.split("/jobs/view/")[1];
      const canonicalSlug = lastPart.replace(/-\d+$/, "");
      return `https://www.linkedin.com/jobs/view/${canonicalSlug}`;
    }
    return raw;
  } catch {
    return raw;
  }
}

function getDedupeKey(rawUrl) {
  const u = normalizeUrl(rawUrl);
  if (u.includes("linkedin.com/jobs/view/")) return canonicalizeLinkedInJobUrl(u);
  return u;
}

/* ---------------------
   DB upsert
--------------------- */
async function upsertJob(client, source, item) {
  const canonicalUrl =
    source === "LinkedIn"
      ? canonicalizeLinkedInJobUrl(item.url)
      : item.url;

  await client.query(
    `INSERT INTO job_posts
      (source, title, url, canonical_url, description, first_seen)
     VALUES ($1,$2,$3,$4,$5,NOW())
     ON CONFLICT (source, canonical_url)
     DO UPDATE SET
       title = EXCLUDED.title,
       description = COALESCE(EXCLUDED.description, job_posts.description)`,
    [source, item.title, item.url, canonicalUrl, item.description || null]
  );
}

function levelNotBlacklisted(title, desc) {
  const LEVEL_BLACKLIST = [
    "medior", "senior", "lead", "principal", "expert",
    "staff", "architect", "sr.", "sr ", "sen.",
    "experienced", "expertise"
  ];
  const t = normalizeText(`${title ?? ""} ${desc ?? ""}`);
  return !LEVEL_BLACKLIST.some(w => t.includes(normalizeText(w)));
}

/* =========================
   BLACKLISTING
========================= */
const BLACKLIST_SOURCES = ["profession"];

const BLACKLIST_URLS = [
  "https://www.profession.hu/allasok/it-programozas-fejlesztes/budapest/1,10,23,internship",
  "https://www.profession.hu/allasok/it-uzemeltetes-telekommunikacio/budapest/1,25,23,gyakornok,0,0,0,0,0,0,0,0,0,10",
  "https://www.profession.hu/allasok/it-uzemeltetes-telekommunikacio/budapest/1,25,23,internship"
];

/* ---------------------
   Main (Netlify handler)
--------------------- */
export default async () => {
  function applyBlacklist(items, sourceKey) {
    const sourceBlocked = BLACKLIST_SOURCES.some(src =>
      sourceKey.toLowerCase().startsWith(src)
    );

    if (!sourceBlocked) return items;

    return items.filter(it =>
      !BLACKLIST_URLS.includes(normalizeUrl(it.url))
    );
  }

  const SOURCES = [
    { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?keywords=developer&location=Budapest" },
    { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/collections/recommended/?currentJobId=4345945964&discover=recommended&discoveryOrigin=JOBS_HOME_JYMBII" },
    { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/collections/recommended/?discover=recommended&discoveryOrigin=JOBS_HOME_JYMBII" },
    { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?distance=0&f_E=2&f_TPR=r86400&keywords=developer&location=Budapest&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
    { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?distance=0&f_E=1&f_TPR=r86400&keywords=developer&location=Budapest&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
    { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?distance=0&f_E=1&keywords=developer&location=Budapest&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
    { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?distance=0&f_E=2&keywords=developer&location=Budapest&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
    { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?distance=10&f_E=2&f_TPR=r86400&keywords=developer&location=Budapest&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
    { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?distance=10&f_E=1&f_TPR=r86400&keywords=developer&location=Budapest&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
    { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?distance=10&f_E=1&keywords=developer&location=Budapest&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
    { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?distance=10&f_E=2&keywords=developer&location=Budapest&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
    { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?f_E=2&keywords=developer&location=Budapest&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
    { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?distance=5&f_E=2&keywords=developer&location=Budapest&origin=JOB_SEARCH_PAGE_JOB_FILTER" },

    { key: "cvonline", label: "cvonline", url: "https://www.cvonline.hu/hu/allashirdetesek/it-informatika-0/budapest/apprenticeships" },
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

      const rawItems =
        p.key === "LinkedIn"
          ? extractLinkedInJobs(html)
          : extractCandidates(html, p.url);

      let items = rawItems.filter(it => {
        const needKeywords = p.key === "LinkedIn" || p.key === "cvonline";
        if (needKeywords && !matchesKeywords(it.title, it.description)) return false;
        if (!levelNotBlacklisted(it.title, it.description)) return false;
        if (!titleNotBlacklisted(it.title)) return false;
        return true;
      });

      items = applyBlacklist(items, p.key);

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
    console.log(`Script started at ${new Date().toISOString()}`);
    client.release();
    pool.end();
  }

  return new Response("OK");
};
