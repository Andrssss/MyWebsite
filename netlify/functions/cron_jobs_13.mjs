// netlify/functions/cron_jobs_13.mjs
console.log("CRON_JOBS_13 LOADED");
export const config = {
  schedule: "10 4-23 * * *",
};

/* =========================
const SOURCES = [
  { key: "cvcentrum-gyakornok-it", label: "CV Centrum – gyakornok IT", url: "https://cvcentrum.hu/allasok/?s=gyakornok&category%5B%5D=it&category%5B%5D=it-programozas&category%5B%5D=it-uzemeltetes&type=&location%5B%5D=budapest&_noo_job_field_year_experience=&post_type=noo_job" },
];
*/


import https from "node:https";
import http from "node:http";
import zlib from "node:zlib";
import { load as cheerioLoad } from "cheerio";
import pkg from "pg";
const { Pool } = pkg;

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
  { key: "cvcentrum-gyakornok-it", label: "CV Centrum – gyakornok IT", url: "https://cvcentrum.hu/allasok/?s=gyakornok&category%5B%5D=it&category%5B%5D=it-programozas&category%5B%5D=it-uzemeltetes&type=&location%5B%5D=budapest&_noo_job_field_year_experience=&post_type=noo_job" },
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
  "szoftverfejleszto",
  "engineer",
  "software",
  "data",
  "analyst",
  "scientist",
  "automation",
  "java",
  "python",
  "AI",
  "Cybersecurity",
  "javascript",
  "php",
  "c++",
  "nodejs",
  "database",
  "test",
  "teszt",
  "testing",
  "teszteles",
  "tesztelés",
  "web",
  "weboldal",
  "net",
  "node",
  "typescript",
  "sql",
  "frontend",
  "backend",
  "fullstack",
  "full-stack",
  "webfejleszto",
  "webfejlesztő",
  "react",
  "angular",
  "devops",
  "cloud",
  "infrastructure",
  "platform",
  "platforms",
  "service",
  "services",
  "helpdesk",
  "security",
  "biztonsag",
  "biztonsagi",
  "biztonsági",
  "biztonsagtechnikai",
  "biztonságtechnikai",
  "kiberbiztonsag",
  "kiberbiztonsági",
  "kiberbiztonság",
  "rendszermernok",
  "rendszermérnök",
  "uzemeltetes",
  "uzemeltetesi",
  "üzemeltetés",
  "üzemeltetési",
  "penzugy",
  "pénzügy",
  "penzugyi",
  "pénzügyi",
  "digitalis",
  "digitális",
  "power",
  "application",
  "system",
  "systems",
  "engineering",
  "development",
  "program",
  "programozo",
  "integration",
  "technical",
  "quality",
  "servicenow",
  "linux",
  "android",
  "databricks",
  "abap",
  "sap",
  "informatikai",
  "informatika",
  "rendszer",
  "rendszergazda",
  "rendszeruzemelteto",
  "rendszeruzemeltető",
  "uzemelteto",
  "üzemeltető",
  "szoftvertesztelo",
  "szoftvertesztelő",
  "manual",
  "embedded",
  "systemtest",
  "tesztrendszer",
  "applications",
  "graduate",
  "graduates",
  "tesztelo",
  "support",
  "operations",
  "qa",
  "tester",
  "sysadmin",
  "network",
  "jog",
  "jogi",
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

const INTERNSHIP_KEYWORDS = [
  "gyakornok", "intern", "internship", "trainee",
  "pályakezdő", "palyakezdo", "diákmunka", "diakmunka",
];

function isInternshipTitle(title) {
  const n = normalizeText(title ?? "");
  return INTERNSHIP_KEYWORDS.some(k => n.includes(k));
}

function hasWord(n, w) {
  // szóhatár: it ne találjon bele más szavakba
  const re = new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  return re.test(n);
}





function matchesKeywords(title, desc) {
  const n = normalizeText(`${title ?? ""} ${desc ?? ""}`);

  const strongHit = KEYWORDS_STRONG.some(k => n.includes(normalizeText(k)));
  const itHit = hasWord(n, "it"); // csak külön szóként
  const aiHit = hasWord(n, "ai"); // csak külön szóként

  // szabály:
  // - ha van strongHit → ok
  // - ha csak "it" vagy "ai" van, az NEM elég (különben túl sok false positive)
  return strongHit || ((itHit || aiHit) && /support|sysadmin|network|qa|tester|developer|data|analyst|operations|security|biztonsag|tanacsado|consultant|engineer|fejleszto|fejlesztő/.test(n));
}

function isSeniorLike(title = "", desc = "") {
  const n = normalizeText(`${title} ${desc}`);
  return SENIOR_KEYWORDS.some(k => n.includes(normalizeText(k)));
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
          "User-Agent": "JobWatcher/1.0",
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
      description: desc ? desc.slice(0, 800) : null,
    });
  });

  return dedupeByUrl(items);
}



// =====================
// DB upsert (csak write=1 esetén)
// =====================
async function upsertJob(client, source, item) {
  const canonicalUrl = normalizeUrl(item.url);
  const experience = item.experience ?? extractExperience(item.description);

  await client.query(
    `INSERT INTO job_posts
      (source, title, url, experience, first_seen)
     VALUES ($1,$2,$3,$4,NOW())
     ON CONFLICT (source, url)
     DO NOTHING;
    `,
    [
      source,
      item.title,
      canonicalUrl,
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
      // EXTRACT & FILTER
      // =========================
      const merged = extractCandidates(html, p.url).filter((c) => looksLikeJobUrl(source, c.url));

      // =========================
      // KEYWORD MATCH
      // =========================
      let matchedList = merged
        .filter((c) => matchesKeywords(c.title, c.description))
        .filter((c) => !isSeniorLike(c.title, c.description));



      // =========================
      // BLACKLISTING
      // =========================
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
      if (write && client) {
        for (const item of matchedList) {
          if (isInternshipTitle(item.title)) item.experience = "diákmunka";
          await upsertJob(client, source, item);
        }
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
    await runBatch({ batch: 0, size: SOURCES.length, write: true, debug: false, bundleDebug: false });
    return new Response("Cron jobs done", { status: 200 });
  }

  const batch = Number(url.searchParams.get("batch") || 0);
  const size = Number(url.searchParams.get("size") || SOURCES.length);

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
