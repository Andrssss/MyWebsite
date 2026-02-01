

globalThis.File ??= class File {};
globalThis.Blob ??= class Blob {};
globalThis.FormData ??= class FormData {};

const https = require("https");
const http = require("http");
const zlib = require("zlib");
const cheerio = require("cheerio");
const { Pool } = require("pg");

// =====================
// DB (write=1 esetén)
// =====================
const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

// =====================
// Response helper
// =====================
function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify(body),
  };
}

// =====================
// Text helpers
// =====================
function stripAccents(s) {
  return String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
function normalizeText(s) {
  return stripAccents(String(s ?? "")).replace(/\s+/g, " ").trim().toLowerCase();
}
function normalizeWhitespace(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

async function fetchJson(url, redirectLeft = 5) {
  const txt = await fetchText(url, redirectLeft);
  try {
    return JSON.parse(txt);
  } catch (e) {
    const preview = txt.slice(0, 300);
    throw new Error(`JSON parse failed for ${url}: ${e.message}. Preview: ${preview}`);
  }
}

// =====================
// URL helpers
// =====================
function normalizeUrl(raw) {
  try {
    const u = new URL(raw);

    // --- LINKEDIN FIX ---
    if (u.hostname.includes("linkedin.com") && u.pathname.startsWith("/jobs/view/")) {
      u.search = "";
      u.hash = "";
      return u.toString();
    }

    // --- ÁLTALÁNOS TISZTÍTÁS ---
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

function mergeCandidates(...lists) {
  const merged = [];
  for (const arr of lists) if (Array.isArray(arr)) merged.push(...arr);
  return dedupeByUrl(merged);
}

// =====================
// Keywords / filters
// =====================
const KEYWORDS_STRONG = [
  "gyakornok","intern","internship","trainee","junior",
  "developer","fejlesztő","fejleszto","data","analyst",
  "support","operations","qa","tester","sysadmin","network"
];

const TITLE_BLACKLIST = [
  "marketing","sales","hr","finance","pénzügy","könyvelő",
  "accountant","manager","vezető","director","adminisztráció",
  "asszisztens","ügyfélszolgálat","customer service","call center",
  "értékesítő","bizto sítás","tanácsadó"
];

const LINKEDIN_TITLE_WHITELIST = [
  "developer","fejlesztő","fejleszto","software","engineer",
  "data","analyst","qa","tester","devops","cloud",
  "backend","frontend","fullstack","it","security","network","sysadmin"
];

function titleNotBlacklisted(title) {
  const t = normalizeText(title);
  return !TITLE_BLACKLIST.some(word => t.includes(normalizeText(word)));
}

function linkedinTitleAllowed(title) {
  const t = normalizeText(title);
  return LINKEDIN_TITLE_WHITELIST.some(word => t.includes(normalizeText(word)));
}

function matchesKeywords(title, desc) {
  const n = normalizeText(`${title ?? ""} ${desc ?? ""}`);
  const strongHit = KEYWORDS_STRONG.some(k => n.includes(normalizeText(k)));
  const itHit = /\bit\b/i.test(n);
  return strongHit || (itHit && /support|sysadmin|network|qa|tester|developer|data|analyst|operations|security|biztonsag|tanacsado|consultant/.test(n));
}

// =====================
// Fetch helpers
// =====================
function fetchText(url, redirectLeft = 5) {
  return new Promise((resolve, reject) => {
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
          return resolve(fetchText(nextUrl, redirectLeft-1));
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

// =====================
// Generic HTML extraction
// =====================
function extractCandidates(html, baseUrl) {
  const $ = cheerio.load(html);
  const items = [];
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    const url = new URL(href, baseUrl).toString();
    if (!/^https?:\/\//i.test(url)) return;

    let card = $(el).closest("article, li, .job-list-item, .job, .position, .listing, .card, .item");
    if (!card.length) card = $(el).closest("div");

    let title = normalizeWhitespace($(el).text()) || normalizeWhitespace(card.find("h1,h2,h3,h4,h5,h6").first().text());
    if (!title || title.length < 4) return;

    const desc = normalizeWhitespace(card.find("p").first().text()) || null;

    items.push({ title: title.slice(0,300), url, description: desc ? desc.slice(0,800) : null });
  });
  return dedupeByUrl(items);
}

// =====================
// LinkedIn-specific extractor
// =====================
function extractLinkedInJobs(html) {
  const $ = cheerio.load(html);
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

// =====================
// DB upsert
// =====================
async function upsertJob(client, source, item) {
  const canonicalUrl = source === "LinkedIn" ? canonicalizeLinkedInJobUrl(item.url) : item.url;
  await client.query(
    `INSERT INTO job_posts
      (source, title, url, canonical_url, description, first_seen)
     VALUES ($1,$2,$3,$4,$5,NOW())
     ON CONFLICT (source, canonical_url)
     DO UPDATE SET title = EXCLUDED.title,
                   description = COALESCE(EXCLUDED.description, job_posts.description)
    `,
    [source, item.title, item.url, canonicalUrl, item.description || null]
  );
}

// =====================
// Sources
// =====================
const SOURCES = [
  { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?keywords=developer&location=Budapest" },
  { key: "cvonline", label: "cvonline", url: "https://www.cvonline.hu/hu/allashirdetesek/it-informatika-0/budapest/apprenticeships" }
];

// =====================
// Handler
// =====================
exports.handler = async (event) => {
  const qs = event.queryStringParameters || {};
  const debug = qs.debug === "1";
  const write = qs.write === "1" || !debug;

  const batch = Math.max(parseInt(qs.batch || "0",10),0);
  const size = Math.min(Math.max(parseInt(qs.size || "4",10),1),8);
  const listToProcess = SOURCES.slice(batch*size, batch*size+size);
  const client = write ? await pool.connect() : null;

  const stats = { ok:true, ranAt: new Date().toISOString(), processedThisRun:listToProcess.length, portals:[] };

  try {
    for (const p of listToProcess) {
      const source = p.key;
      let html = null;

      try { html = await fetchText(p.url); } 
      catch (err) { stats.portals.push({ source, ok:false, error: err.message }); continue; }

      let items = [];

      if (source === "LinkedIn") {
  // LinkedIn-specific extractor
  let rawJobs = extractLinkedInJobs(html);

  // filter: title must contain "intern", "gyakornok" or "junior"
  // AND must contain at least one whitelist word
  items = rawJobs.filter(job => {
    const t = normalizeText(job.title);
    const hasInternJunior = /\b(intern|gyakornok|junior|trainee)\b/i.test(t);
    const hasWhitelistWord = LINKEDIN_TITLE_WHITELIST.some(w => t.includes(normalizeText(w)));
    return hasInternJunior && hasWhitelistWord && titleNotBlacklisted(job.title);
  });
}
 else {
        // Generic extractor for other portals
        const generic = extractCandidates(html, p.url);
        items = generic.filter(c => matchesKeywords(c.title, c.description) && titleNotBlacklisted(c.title));
      }

      if (write && client) {
        let upserted = 0;
        for (const it of items) {
          try { await upsertJob(client, source, it); upserted++; } catch {}
        }
        stats.portals.push({ source, ok:true, count: items.length, upserted });
      } else {
        stats.portals.push({ source, ok:true, count: items.length });
      }
    }

    return json(200, stats);

  } catch (err) {
    return json(500, { ok:false, error: err.message });
  } finally {
    if (client) client.release();
  }
};
