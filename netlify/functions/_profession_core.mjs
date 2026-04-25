import https from "node:https";
import http from "node:http";
import zlib from "node:zlib";
import { load as cheerioLoad } from "cheerio";
import pkg from "pg";
const { Pool } = pkg;
import { loadFilters } from "./load_filters.mjs";
import { logFetchError } from "./_error-logger.mjs";

let _filters = [];

// =====================
// DB
// =====================
const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

// =====================
// HELPERS
// =====================
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function stripAccents(s) {
  return String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function normalizeText(s) {
  return stripAccents(s).replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizeWhitespace(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

function isProfessionNoResultsPage(html) {
  const n = normalizeText(html);
  return (
    n.includes("nem talaltunk allast") ||
    n.includes("nem talaltunk allast a megadott feltetelekkel") ||
    n.includes("kerjuk modositsa kereseset")
  );
}

function professionPageUrl(baseUrl, page) {
  try {
    const u = new URL(baseUrl);
    const parts = u.pathname.split("/");
    const last = parts[parts.length - 1] || "";
    const m = last.match(/^(\d+),(.+)$/);
    if (m) {
      parts[parts.length - 1] = `${page},${m[2]}`;
      u.pathname = parts.join("/");
    }
    return u.toString();
  } catch {
    return baseUrl;
  }
}

function normalizeUrl(raw) {
  try {
    const u = new URL(raw);
    u.hash = "";
    [
      "utm_source", "utm_medium", "utm_campaign", "utm_term",
      "utm_content", "fbclid", "gclid", "sessionId", "hash", "keyword"
    ].forEach((p) => u.searchParams.delete(p));
    return u.toString().replace(/\?$/, "");
  } catch {
    return raw;
  }
}

function absolutize(href, base) {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

function dedupeByUrl(items) {
  const seen = new Set();
  return items.filter((x) => {
    if (!x.url) return false;
    const u = normalizeUrl(x.url);
    if (seen.has(u)) return false;
    seen.add(u);
    x.url = u;
    return true;
  });
}

// =====================
// Keywords
// =====================
const INTERNSHIP_KEYWORDS = [
  "gyakornok", "intern", "internship", "trainee",
  "pályakezdő", "palyakezdo", "diákmunka", "diakmunka",
];

const INTERN_SOURCES = [
  "minddiak", "muisz", "zyntern", "schonherz", "prodiak",
  "tudasdiak", "tudatosdiak", "ydiak", "qdiak", "frissdiplomas",
];

function isInternshipTitle(title) {
  const n = normalizeText(title ?? "");
  return INTERNSHIP_KEYWORDS.some(k => n.includes(k));
}

function _blacklistRegex(k) {
  const escaped = normalizeText(k).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i");
}

function isSeniorLike(title = "", desc = "") {
  const n = normalizeText(title);
  return _filters.some(k => _blacklistRegex(k).test(n));
}

function looksLikeJobUrl(sourceKey, url) {
  if (!url) return false;
  const u = new URL(url);

  const bad = [
    "/fiokom", "/csomagok", "/hirdetesfeladas",
    "/job-category", "/terulet", "/tag", "/category",
  ];
  if (bad.some(p => u.pathname.startsWith(p))) return false;

  if (sourceKey.startsWith("profession")) {
    const ok = /^\/allas\/[^\/]+-\d+(\/pro)?\/?$/.test(u.pathname);
    return ok;
  }
}

// =====================
// Fetch (gzip/deflate/br + redirect)
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
        timeout: 25000,
      },
      (res) => {
        const code = res.statusCode || 0;

        if ([301, 302, 303, 307, 308].includes(code)) {
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
        stream.on("data", (chunk) => (data += chunk));
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
// Generic extraction (CTA title fix included)
// =====================
const CTA_TITLES = new Set([
  "megnézem", "megnezem", "részletek", "reszletek",
  "tovább", "tovabb", "bővebben", "bovebben",
  "jelentkezem", "jelentkezés", "jelentkezes",
  "apply", "details", "view", "open", "more",
]);

function isCtaTitle(s) {
  const n = normalizeText(s);
  return !n || n.length < 4 || CTA_TITLES.has(n);
}

function extractCandidates(html, baseUrl) {
  const $ = cheerioLoad(html);
  const items = [];

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;

    const url = absolutize(href, baseUrl);
    if (!url) return;

    if (!/^https?:\/\//i.test(url)) return;
    if (/\.(jpg|jpeg|png|gif|svg|webp|pdf|zip|rar|7z)(\?|#|$)/i.test(url)) return;

    let card = $(el).closest("app-job-list-item, article, li, .job-list-item, .job, .position, .listing, .card, .item");
    if (!card.length) card = $(el).closest("div");

    const linkText = normalizeWhitespace($(el).text());
    const headingText =
      normalizeWhitespace(card.find("h1,h2,h3,h4,h5,h6").first().text()) ||
      normalizeWhitespace($(el).parent().find("h1,h2,h3,h4,h5,h6").first().text());

    let title = linkText;
    if (headingText && (isCtaTitle(linkText) || headingText.length > linkText.length + 3)) {
      title = headingText;
    }

    title = normalizeWhitespace(title);
    if (!title || title.length < 4) return;

    const desc =
      normalizeWhitespace(card.find("p").first().text()) ||
      normalizeWhitespace(card.find(".description, .job-desc, .job-description").first().text()) ||
      null;

    items.push({
      title: title.slice(0, 300),
      url,
      description: desc ? desc.slice(0, 800) : null,
    });
  });

  return dedupeByUrl(items);
}

async function extractProfessionCandidatesAllPages(source, baseUrl, startPage = 1, maxPages = Infinity) {
  const all = [];
  const seenUrls = new Set();
  let pagesVisited = 0;
  let pagesWithJobs = 0;

  for (let page = startPage; ; page++) {
    if (maxPages !== Infinity && page >= startPage + maxPages) {
      console.log(`[profession] maxPages limit (${maxPages}) reached, stopping at page ${page}`);
      break;
    }
    const pageUrl = professionPageUrl(baseUrl, page);
    let html;
    try {
      html = await fetchText(pageUrl);
    } catch (err) {
      console.log(`[profession] fetch error at page ${page}: ${err.message} — stopping pagination`);
      break;
    }
    pagesVisited++;

    if (isProfessionNoResultsPage(html)) {
      console.log(`[profession] no results at page ${page}: ${pageUrl}`);
      break;
    }

    const pageItems = extractCandidates(html, pageUrl).filter((c) =>
      looksLikeJobUrl(source, c.url)
    );

    if (!pageItems.length) {
      console.log(`[profession] no job cards at page ${page}: ${pageUrl}`);
      break;
    }

    let newItems = 0;
    for (const it of pageItems) {
      const key = normalizeUrl(it.url);
      if (seenUrls.has(key)) continue;
      seenUrls.add(key);
      all.push(it);
      newItems++;
    }

    if (newItems === 0) {
      console.log(`[profession] stop at page ${page}: no new job URLs: ${pageUrl}`);
      break;
    }

    pagesWithJobs++;
    await sleep(10);
  }

  return {
    items: dedupeByUrl(all),
    pagesVisited,
    pagesWithJobs,
  };
}

// =====================
// DB upsert
// =====================
async function upsertJob(client, source, item) {
  const canonicalUrl = normalizeUrl(item.url);

  await client.query(
    `INSERT INTO job_posts
      (source, title, url, experience, first_seen)
     VALUES ($1,$2,$3,$4,NOW())
     ON CONFLICT (source, url)
     DO NOTHING;
    `,
    [source, item.title, canonicalUrl, item.experience || null]
  );
}

// =====================
// BLACKLISTING
// =====================
const BLACKLIST_SOURCES = ["profession"];
const BLACKLIST_URLS = [
  "https://www.profession.hu/allasok/it-uzemeltetes-telekommunikacio/budapest/1,25,23,internship",
  "https://www.profession.hu/allasok/programozo-fejleszto/budapest/1,10,23,0,75",
  "https://www.profession.hu/allasok/it-tanacsado-elemzo-auditor/budapest/1,10,23,0,201",
];

// =====================
// Main processing function
// =====================
export async function processProfessionSources(sources, jobName, request, pageOptions = {}) {
  _filters = await loadFilters();
  const url = new URL(request.url);

  const debug = url.searchParams.get("debug") === "1";
  const bundleDebug = url.searchParams.get("bundledebug") === "1";
  const write = url.searchParams.get("write") === "1";

  if (!debug) {
    // Normal cron mode — process all sources
    const client = await pool.connect();
    try {
      for (const p of sources) {
        await processOneSource(client, p, jobName, pageOptions);
        await sleep(50);
      }
    } finally {
      client.release();
    }
    return new Response("Cron jobs done", { status: 200 });
  }

  // Debug mode
  const batch = Number(url.searchParams.get("batch") || 0);
  const size = Number(url.searchParams.get("size") || 4);
  const listToProcess = sources.slice(batch * size, batch * size + size);

  const client = write ? await pool.connect() : null;

  const stats = {
    ok: true,
    node: process.version,
    ranAt: new Date().toISOString(),
    debug: true,
    bundleDebug: !!bundleDebug,
    write: !!write,
    batch,
    size,
    processedThisRun: listToProcess.length,
    totalSources: sources.length,
    portals: [],
  };

  try {
    for (const p of listToProcess) {
      const result = await processOneSource(client, p, jobName, pageOptions);
      stats.portals.push(result);
    }
  } finally {
    if (client) client.release();
  }

  return new Response(JSON.stringify(stats), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function processOneSource(client, p, jobName, { startPage = 1, maxPages = Infinity } = {}) {
  const source = p.key;

  let merged = [];
  try {
    if (source.startsWith("profession")) {
      const professionResult = await extractProfessionCandidatesAllPages(source, p.url, startPage, maxPages);
      merged = professionResult.items;
      console.log(
        `[profession] crawled ${professionResult.pagesVisited} page(s), ` +
          `${professionResult.pagesWithJobs} page(s) with jobs for source URL: ${p.url}`
      );
    } else {
      const html = await fetchText(p.url);
      merged = extractCandidates(html, p.url).filter((c) => looksLikeJobUrl(source, c.url));
    }
  } catch (err) {
    await logFetchError(jobName, { url: p.url, message: err.message });
    console.error(`[${jobName}] fetch failed for ${p.url}: ${err.message}`);
    return { source, label: p.label, url: p.url, ok: false, error: err.message };
  }

  let matchedList = merged.filter((c) => !isSeniorLike(c.title, c.description));

  if (BLACKLIST_SOURCES.some(src => source.startsWith(src))) {
    matchedList = matchedList.filter(c => !BLACKLIST_URLS.includes(c.url));
  }

  if (client) {
    for (const item of matchedList) {
      if (isInternshipTitle(item.title)) item.experience = "diákmunka";

      const diakMatch = item.title.match(/^\s*[Dd]i[áa]kmunka\s*[-–—:]\s*(.+)/);
      if (diakMatch) {
        const stripped = diakMatch[1].replace(/\s+/g, " ").trim();
        const { rowCount } = await client.query(
          `SELECT 1 FROM job_posts
           WHERE source = ANY($1::text[])
             AND LOWER(TRIM(REGEXP_REPLACE(title, '\\s+', ' ', 'g')))
                 = LOWER($2)
           LIMIT 1`,
          [INTERN_SOURCES, stripped]
        );
        if (rowCount > 0) {
          console.log(`[dedupe] skipped "${item.title}" — duplicate of intern source`);
          continue;
        }
      }

      await upsertJob(client, source, item);
    }
  }

  console.log(`[${jobName}] ${source}: ${matchedList.length} items processed for ${p.url}`);
  return { source, label: p.label, url: p.url, ok: true, matched: matchedList.length };
}
