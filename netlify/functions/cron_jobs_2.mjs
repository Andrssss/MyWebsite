// netlify/functions/cron_jobs_2.mjs
console.log("CRON_JOBS LOADED");
export const config = {
  schedule: "5 4,10,16 * * *",
};

globalThis.File ??= class File {};
globalThis.Blob ??= class Blob {};
globalThis.FormData ??= class FormData {};

import https from "node:https";
import http from "node:http";
import zlib from "node:zlib";
import { load as cheerioLoad } from "cheerio";
import pkg from "pg";
const { Pool } = pkg;
import { chromium } from "playwright"; // at the top of your file

// =====================
// DB
// =====================
const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});


 
async function runAllBatches() {
  const size = 4;
  const totalBatches = Math.ceil(SOURCES.length / size);

  console.log("[runAllBatches]", totalBatches, "batches");

  for (let batch = 0; batch < totalBatches; batch++) {
    await runBatch({ batch, size, write: true, debug: false, bundleDebug: false });
    await sleep(50);
  }
}



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






function normalizeUrl(raw) {
  try {
    const u = new URL(raw);

    // Remove hash
    u.hash = "";

    // Remove common tracking params
    [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "fbclid",
  "gclid",
  "sessionId",
  "hash",
  "keyword"
].forEach((p) => u.searchParams.delete(p));

    // =========================
    // CV Centrum: strip numeric suffix like -2-2 and -3 at the end
    // =========================
    if (u.hostname.includes("cvcentrum.hu") && /^\/allasok\/.*-\d+-\d+\/?$/.test(u.pathname)) {
      u.pathname = u.pathname.replace(/-\d+(-\d+)?\/?$/, "");    
    }

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

function mergeCandidates(...lists) {
  // flatten + dedupe URL alapján
  const merged = [];
  for (const arr of lists) {
    if (Array.isArray(arr)) merged.push(...arr);
  }
  return dedupeByUrl(merged);
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
// Sources (csak az első 4 debugolásra)
// =====================
const SOURCES = [
 // { key: "cvcentrum-gyakornok-it", label: "CV Centrum – gyakornok IT", url: "https://cvcentrum.hu/allasok/?s=gyakornok&category%5B%5D=it&category%5B%5D=it-programozas&category%5B%5D=it-uzemeltetes&type=&location%5B%5D=budapest&_noo_job_field_year_experience=&post_type=noo_job" },
 // { key: "cvcentrum-gyakornok-it", label: "CV Centrum – gyakornok IT", url: "https://cvcentrum.hu/?s=&category%5B%5D=it&category%5B%5D=it-programozas&category%5B%5D=it-uzemeltetes&type=&location%5B%5D=budapest&_noo_job_field_year_experience=&post_type=noo_job" },
 // { key: "cvcentrum-gyakornok-it", label: "CV Centrum – gyakornok IT", url: "https://cvcentrum.hu/?s=intern&category%5B%5D=information-technology&category%5B%5D=it&category%5B%5D=it-programozas&category%5B%5D=it-uzemeltetes&category%5B%5D=networking&type=&_noo_job_field_year_experience=&post_type=noo_job" },
  
  { key: "profession-intern", label: "Profession – Intern", url: "https://www.profession.hu/allasok/it-programozas-fejlesztes/budapest/1,10,23,intern" },
  { key: "profession-intern", label: "Profession – Intern", url: "https://www.profession.hu/allasok/it-programozas-fejlesztes/budapest/1,10,23" },
  { key: "profession-intern", label: "Profession – Intern", url: "https://www.profession.hu/allasok/it-uzemeltetes-telekommunikacio/budapest/1,25,23,gyakornok" },
  { key: "profession-intern", label: "Profession – Intern", url: "https://www.profession.hu/allasok/adatbazisszakerto/budapest/1,10,23,0,200" },
  { key: "profession-intern", label: "Profession – Intern", url: "https://www.profession.hu/allasok/programozo-fejleszto/budapest/1,10,23,0,75" },
  { key: "profession-intern", label: "Profession – Intern", url: "https://www.profession.hu/allasok/tesztelo-tesztmernok/budapest/1,10,23,0,80" },
];

// =====================
// Keywords
// =====================
const KEYWORDS_STRONG = [
  "gyakornok",
  "intern",
  "internship",
  "trainee",
  "junior",
  "developer",
  "fejlesztő",
  "fejleszto",
  "data",
  "analyst",
  "support",
  "operations",
  "qa",
  "tester",
  "sysadmin",
  "network",
  "jog",
  "jogi"
];



const SENIOR_KEYWORDS = [
  "senior",
    "szenior",
    "medior",
  "lead",
  "principal",
  "staff",
  "architect",
  "expert",
  "vezető fejlesztő",
  "tech lead"
];

function hasWord(n, w) {
  // szóhatár: it ne találjon bele más szavakba
  const re = new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  return re.test(n);
}





function matchesKeywords(title, desc) {
  const n = normalizeText(`${title ?? ""} ${desc ?? ""}`);

  const strongHit = KEYWORDS_STRONG.some(k => n.includes(normalizeText(k)));
  const itHit = hasWord(n, "it"); // csak külön szóként

  // szabály:
  // - ha van strongHit → ok
  // - ha csak "it" van, az NEM elég (különben túl sok false positive)
  return strongHit || (itHit && /support|sysadmin|network|qa|tester|developer|data|analyst|operations|security|biztonsag|tanacsado|consultant/.test(n));
}

function isSeniorLike(title = "", desc = "") {
  const n = normalizeText(`${title} ${desc}`);
  return SENIOR_KEYWORDS.some(k => n.includes(normalizeText(k)));
}


function extractSSR(html, baseUrl) {
  const $ = cheerioLoad(html);
  const items = [];

  // Tipikus "kártya" konténerek / list item-ek
  const CARD_SELECTORS = [
    "app-job-list-item",
    "article",
    "li",
    ".job",
    ".job-list-item",
    ".position",
    ".listing",
    ".card",
    ".item",
    ".vacancy",
    ".vacancies__item",
    "[data-href]",
    "[data-url]",
    "[onclick]",
    "[role='link']",
    "[routerlink]",
  ].join(",");

  $(CARD_SELECTORS).each((_, el) => {
    const $card = $(el);

    // 1) link kinyerés: data-href/data-url/routerlink/onclick/benne lévő a[href]
    let href =
      $card.attr("data-href") ||
      $card.attr("data-url") ||
      $card.attr("routerlink") ||
      null;

    if (!href) {
      // onclick="location.href='...'" / window.location='...'
      const oc = $card.attr("onclick") || "";
      const m = oc.match(/(?:location\.href|window\.location)\s*=\s*['"]([^'"]+)['"]/i)
        || oc.match(/['"]([^'"]+)['"]/); // fallback: első string
      if (m && m[1]) href = m[1];
    }

    if (!href) {
      // ha nincs "kártya link", akkor nézzük a kártyán belüli legjobb linket
      const a = $card.find("a[href]").first();
      href = a.attr("href") || null;
    }

    const url = href ? absolutize(href, baseUrl) : null;
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) return;
    if (/\.(jpg|jpeg|png|gif|svg|webp|pdf|zip|rar|7z)(\?|#|$)/i.test(url)) return;

    // 2) cím kinyerés: heading > erős szöveg > valami rövidebb text
    let title =
      normalizeWhitespace($card.find("h1,h2,h3,h4,h5,h6").first().text()) ||
      normalizeWhitespace($card.find(".title,.job-title,.position-title,.name").first().text()) ||
      normalizeWhitespace($card.find("strong").first().text()) ||
      null;

    if (!title || title.length < 4) {
      // ha nincs jó title, próbáljuk a link szövegét (de CTA-nál ez rossz, ezért CTA szűrés)
      const aText = normalizeWhitespace($card.find("a[href]").first().text());
      if (aText && !isCtaTitle(aText)) title = aText;
    }

    title = normalizeWhitespace(title);
    if (!title || title.length < 4) return;
    if (isCtaTitle(title)) return; // “Megnézem / Részletek” ne legyen cím

    // 3) leírás (opcionális)
    const desc =
      normalizeWhitespace($card.find("p").first().text()) ||
      normalizeWhitespace($card.find(".description,.job-desc,.job-description").first().text()) ||
      null;

    items.push({
      title: title.slice(0, 300),
      url,
      description: desc ? desc.slice(0, 5000) : null,
    });
  });

  return dedupeByUrl(items);
}




function keywordHit(title, desc) {
  const n = normalizeText(`${title ?? ""} ${desc ?? ""}`);

  const hits = [];
  if (hasWord(n, "it")) hits.push("it"); // szóhatáros
  for (const k of KEYWORDS_STRONG) {
    const nk = normalizeText(k);
    if (nk !== "it" && n.includes(nk)) hits.push(k);
  }
  return hits;
}


function looksLikeJobUrl(sourceKey, url) {
  if (!url) return false;
  const u = new URL(url);

  // általános szemét
  const bad = [
    "/fiokom",
    "/csomagok",
    "/hirdetesfeladas",
    "/job-category",
    "/terulet",
    "/tag",
    "/category",
  ];
  if (bad.some(p => u.pathname.startsWith(p))) return false;

  // =========================
  // PROFESSION – CSAK VALÓDI ÁLLÁS
  // =========================
  if (sourceKey.startsWith("profession")) {
    /**
     * Elfogadott minták:
     * /allas/<slug>-<szam>
     * /allas/<slug>-<szam>/pro
     */
    const ok = /^\/allas\/[^\/]+-\d+(\/pro)?\/?$/.test(u.pathname);
    return ok;
  }

  // CVCentrum
  if (sourceKey.startsWith("cvcentrum")) {
    if (!/^\/allasok\/[^\/]+\/?$/.test(u.pathname)) return false;
  }
  return true;
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
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
          "Accept-Language": "hu-HU,hu;q=0.9,en;q=0.8",
          "Accept-Encoding": "gzip,deflate,br",
        },
        timeout: 50000,
      },
      (res) => {
        const code = res.statusCode || 0;

        // redirect
        if ([301, 302, 303, 307, 308].includes(code)) {
          const loc = res.headers.location;
          if (!loc) return reject(new Error(`HTTP ${code} (no Location) for ${url}`));
          if (redirectLeft <= 0) return reject(new Error(`Too many redirects for ${url}`));
          const nextUrl = new URL(loc, url).toString();
          res.resume();
          return resolve(fetchText(nextUrl, redirectLeft - 1));
        }

        // decompress
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
  "megnézem",
  "megnezem",
  "részletek",
  "reszletek",
  "tovább",
  "tovabb",
  "bővebben",
  "bovebben",
  "jelentkezem",
  "jelentkezés",
  "jelentkezes",
  "apply",
  "details",
  "view",
  "open",
  "more",
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
      description: desc ? desc.slice(0, 5000) : null,
    });
  });

  return dedupeByUrl(items);
}



// =====================
// DB upsert (csak write=1 esetén)
// =====================
async function upsertJob(client, source, item) {
  const experience = extractExperience(item.description);
  //console.log(item.description);

  await client.query(
    `INSERT INTO job_posts
      (source, title, url, description, experience, first_seen)
     VALUES ($1,$2,$3,$4,$5,NOW())
     ON CONFLICT (source, url)
     DO UPDATE SET 
       title = EXCLUDED.title,
       description = COALESCE(EXCLUDED.description, job_posts.description),
       experience = COALESCE(EXCLUDED.experience, job_posts.experience)
    `,
    [
      source,
      item.title,
      item.url,
      item.description || null,
      experience
    ]
  );
}



// ---------------------
// Experience extractor
// ---------------------
function extractExperience(description) {
  if (!description) return null;

  const patterns = [
    /(\d+\s?\+\s?(?:év|years?))/gi,
    /(\d+\s?(?:[-–]\s?\d+)?\s?(?:év|éves|years?|yrs?))/gi,
    /(minimum\s?\d+\s?(?:év|years?))/gi,
    /(at least\s?\d+\s?(?:years?))/gi
  ];

  const matches = [];

  for (const regex of patterns) {
    const found = description.match(regex);
    if (found) matches.push(...found);
  }

  return matches.length ? [...new Set(matches)].join(", ") : null;
}




// ✅ Fixed runBatch()
async function runBatch({ batch, size, write, debug = false, bundleDebug = false }) {
  const listToProcess = SOURCES.slice(batch * size, batch * size + size);

  const client = write ? await pool.connect() : null;

  const stats = {
    ok: true,
    node: process.version,
    ranAt: new Date().toISOString(),
    debug: !!debug,
    bundleDebug: !!bundleDebug,
    write: !!write,
    batch,
    size,
    processedThisRun: listToProcess.length,
    totalSources: SOURCES.length,
    portals: [],
  };

  try {
    for (const p of listToProcess) {
      const source = p.key;

      let html = null;
      try {
        html = await fetchText(p.url);
      } catch (err) {
        stats.portals.push({ source, label: p.label, url: p.url, ok: false, error: err.message });
        continue;
      }

    

      // =========================
      // MERGE JOBS
      // =========================
      let merged = [];

       
        let generic = extractCandidates(html, p.url).filter((c) => looksLikeJobUrl(source, c.url));
        let ssr = extractSSR(html, p.url).filter((c) => looksLikeJobUrl(source, c.url));

        let melodiakSSR = [];
        let schonherz = [];

        merged =
          source === "schonherz"
            ? mergeCandidates(schonherz, generic, ssr, melodiakSSR)
            : mergeCandidates(generic, ssr, melodiakSSR);
      

      // =========================
      // FILTER & KEYWORD MATCH
      // =========================
      let matchedList = merged
        .filter((c) => matchesKeywords(c.title, c.description))
        .filter((c) => !isSeniorLike(c.title, c.description));



      // =========================
      // BLACKLISTING
      // =========================
      const BLACKLIST_SOURCES = ["profession"];
      const BLACKLIST_URLS = [
        "https://www.profession.hu/allasok/it-programozas-fejlesztes/budapest/1,10,23,internship",
        "https://www.profession.hu/allasok/it-programozas-fejlesztes/budapest/1,10,23",
        "https://www.profession.hu/allasok/it-uzemeltetes-telekommunikacio/budapest/1,25,23,gyakornok,0,0,0,0,0,0,0,0,0,10",
        "https://www.profession.hu/allasok/it-uzemeltetes-telekommunikacio/budapest/1,25,23,internship",
        "https://www.profession.hu/allasok/programozo-fejleszto/budapest/1,10,23,0,75",
        "https://www.profession.hu/allasok/it-tanacsado-elemzo-auditor/budapest/1,10,23,0,201",

      ];

      if (BLACKLIST_SOURCES.some(src => source.startsWith(src))) {
        matchedList = matchedList.filter(c => !BLACKLIST_URLS.includes(c.url));
      }

      if (source === "cvonline") {
        matchedList = matchedList.filter(c => !c.url.startsWith("https://www.cvonline.hu/hu/company/"));
      }

      const BLACKLIST_WORDS = ["marketing", "sales", "oktatásfejlesztő", "support"];
      matchedList = matchedList.filter(item => {
        const text = `${item.title ?? ""} ${item.description ?? ""}`.toLowerCase();
        return !BLACKLIST_WORDS.some(word => text.includes(word.toLowerCase()));
      });

      // =========================
      // DEBUG REJECTED
      // =========================
      let rejected = [];
      if (debug) {
        rejected = merged
          .filter((c) => !matchesKeywords(c.title, c.description))
          .slice(0, 30)
          .map((c) => {
            const norm = normalizeText(`${c.title ?? ""} ${c.description ?? ""}`);
            return {
              title: c.title,
              url: c.url,
              hits: keywordHit(c.title, c.description),
              normPreview: norm.slice(0, 220),
              itWord: hasWord(norm, "it"),
              hasStrong: KEYWORDS_STRONG.some((k) => norm.includes(normalizeText(k))),
            };
          });
      }

      stats.portals.push({ source, label: p.label, url: p.url, ok: true, matched: matchedList.length, rejected });

      // =========================
      // DB UPSERT
      // =========================
      // =========================
// DB UPSERT (DETAIL FETCH)
// =========================
// =======================
// UPSERT loop with Playwright for Profession.hu
// =======================
if (write && client) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  for (const item of matchedList) {
    if (!item.description) {
      // Only fetch detail page if description is missing
      try {
        let detailHtml;

        if (item.url.includes("profession.hu")) {
          // Use Playwright for JS-rendered Profession.hu pages
          await page.goto(item.url, { waitUntil: "networkidle" });
          detailHtml = await page.content();
        } else {
          // Normal fetch for SSR/static pages
          detailHtml = await fetchText(item.url);
        }

        if (!detailHtml || typeof detailHtml !== "string" || detailHtml.trim() === "") {
          console.warn("Detail page empty or invalid:", item.url);
          continue;
        }

        const $job = cheerioLoad(detailHtml);
        const fullDesc = normalizeWhitespace(
          $job.find(".job-description, .description, .job-desc, p").text()
        );

        if (!fullDesc) {
          console.warn("No description found:", item.url);
          continue; // optional: upsert empty
        }

        item.description = fullDesc;

      } catch (err) {
        console.warn("Failed to fetch detail page:", item.url, err.message);
        continue;
      }
    }

    // Upsert into DB
    await upsertJob(client, source, item);
  }

  await browser.close();
}



    }
  } finally {
    if (client) client.release();
  }

  return stats;
}


export default async (request) => {
  const url = new URL(request.url);

  const debug = url.searchParams.get("debug") === "1";
  const bundleDebug = url.searchParams.get("bundledebug") === "1";
  const write = url.searchParams.get("write") === "1";

  if (!debug) {
    await runAllBatches();
    return new Response("Cron jobs done", { status: 200 });
  }

  const batch = Number(url.searchParams.get("batch") || 0);
  const size = Number(url.searchParams.get("size") || 4);

  const stats = await runBatch({
    batch,
    size,
    write,
    debug: true,
    bundleDebug,
  });

  return new Response(JSON.stringify(stats), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
