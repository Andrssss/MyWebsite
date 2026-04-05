// netlify/functions/cron_jobs.mjs
// netlify/functions/cron_jobs.js
console.log("CRON_JOBS LOADED");
export const config = {
  schedule: "1 4-23 * * *",
};

/* =========================
const SOURCES = [
  { key: "otp", label: "OTP", url: "https://karrier.otpbank.hu/go/Minden-allasajanlat/1167001/?q=&q2=&alertId=&locationsearch=&title=GYAKORNOK&date=&location=&shifttype=" },
  { key: "vizmuvek",  label:  "vizmuvek", url: "https://www.vizmuvek.hu/hu/karrier/gyakornoki-dualis-kepzes" },
  { key: "wherewework", label: "wherewework", url: "https://www.wherewework.hu/en/jobs/budaors,budapest/bpo-services,health-services,other-services,others,pharmaceutical,horeca,itc,trade,agriculture,education" },
  { key: "wherewework", label: "wherewework", url: "https://www.wherewework.hu/en/jobs/student-internship,entry-level-2-years/budapest?page=1" },
  { key: "onejob", label: "onejob", url: "https://onejob.hu/munkaink/?job__category_spec=informatika&job__location_spec=budapest" },
  { key: "nofluffjobs", label: "nofluffjobs", url: "https://nofluffjobs.com/hu/budapest?utm_source=facebook&utm_medium=social_cpc&utm_campaign=hbp&utm_content=Instagram_Reels&utm_id=120239436336450697&utm_term=120239436336520697&fbclid=PAdGRleAP9v2xleHRuA2FlbQEwAGFkaWQBqy0hd5G9WXNydGMGYXBwX2lkDzEyNDAyNDU3NDI4NzQxNAABp-R_SE_c9O6KU5EqFghpD-ajuuKDtviyfnC4ISpI22VXvxQFO3UL-hd8sdBG_aem_9-6Oig3Ju0SERNEIrcg6kw&criteria=seniority%3Dtrainee,junior" },
  { key: "nofluffjobs", label: "nofluffjobs", url: "https://nofluffjobs.com/hu/budapest?criteria=seniority%3Dtrainee,junior" },
  { key: "nofluffjobs", label: "nofluffjobs", url: "https://nofluffjobs.com/hu/budapest?criteria=seniority%3Dtrainee,junior&sort=newest" },
  { key: "nofluffjobs", label: "nofluffjobs", url: "https://nofluffjobs.com/hu/budapest/artificial-intelligence?criteria=requirement%3DJava,Python,C%23,SQL,C%2B%2B,Golang,JavaScript,React,Angular,TypeScript,HTML,Git,Vue.js,Kotlin,Android%20category%3Dsys-administrator,business-analyst,architecture,backend,data,ux,devops,erp,embedded,frontend,fullstack,game-dev,mobile,project-manager,security,support,testing,other%20seniority%3Dtrainee,junior" },
];
*/




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


 
async function runAllBatches() {
  const size = 4;
  const totalBatches = Math.ceil(SOURCES.length / size);

  console.log("[runAllBatches]", totalBatches, "batches");

  for (let batch = 0; batch < totalBatches; batch++) {
    await runBatch({ batch, size, write: true, debug: false, bundleDebug: false });
    await sleep(500);
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
    u.hash = "";
    ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid"].forEach((p) =>
      u.searchParams.delete(p)
    );
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
  { key: "otp", label: "OTP", url: "https://karrier.otpbank.hu/go/Minden-allasajanlat/1167001/?q=&q2=&alertId=&locationsearch=&title=GYAKORNOK&date=&location=&shifttype=" },
  { key: "vizmuvek",  label:  "vizmuvek", url: "https://www.vizmuvek.hu/hu/karrier/gyakornoki-dualis-kepzes" },
  { key: "wherewework", label: "wherewework", url: "https://www.wherewework.hu/en/jobs/budaors,budapest/bpo-services,health-services,other-services,others,pharmaceutical,horeca,itc,trade,agriculture,education" },
  { key: "wherewework", label: "wherewework", url: "https://www.wherewework.hu/en/jobs/student-internship,entry-level-2-years/budapest?page=1" },
  { key: "onejob", label: "onejob", url: "https://onejob.hu/munkaink/?job__category_spec=informatika&job__location_spec=budapest" },
  { key: "nofluffjobs", label: "nofluffjobs", url: "https://nofluffjobs.com/hu/budapest?utm_source=facebook&utm_medium=social_cpc&utm_campaign=hbp&utm_content=Instagram_Reels&utm_id=120239436336450697&utm_term=120239436336520697&fbclid=PAdGRleAP9v2xleHRuA2FlbQEwAGFkaWQBqy0hd5G9WXNydGMGYXBwX2lkDzEyNDAyNDU3NDI4NzQxNAABp-R_SE_c9O6KU5EqFghpD-ajuuKDtviyfnC4ISpI22VXvxQFO3UL-hd8sdBG_aem_9-6Oig3Ju0SERNEIrcg6kw&criteria=seniority%3Dtrainee,junior" },
  { key: "nofluffjobs", label: "nofluffjobs", url: "https://nofluffjobs.com/hu/budapest?criteria=seniority%3Dtrainee,junior" },
  { key: "nofluffjobs", label: "nofluffjobs", url: "https://nofluffjobs.com/hu/budapest?criteria=seniority%3Dtrainee,junior&sort=newest" },
  { key: "nofluffjobs", label: "nofluffjobs", url: "https://nofluffjobs.com/hu/budapest/artificial-intelligence?criteria=requirement%3DJava,Python,C%23,SQL,C%2B%2B,Golang,JavaScript,React,Angular,TypeScript,HTML,Git,Vue.js,Kotlin,Android%20category%3Dsys-administrator,business-analyst,architecture,backend,data,ux,devops,erp,embedded,frontend,fullstack,game-dev,mobile,project-manager,security,support,testing,other%20seniority%3Dtrainee,junior" },
];

// =====================
// Keywords
// =====================

const INTERNSHIP_KEYWORDS = [
  "gyakornok", "intern", "internship", "trainee",
  "pályakezdő", "palyakezdo", "diákmunka", "diakmunka",
];

function isInternshipTitle(title) {
  const n = normalizeText(title ?? "");
  return INTERNSHIP_KEYWORDS.some(k => n.includes(k));
}





function isSeniorLike(title = "", desc = "") {
  const n = normalizeText(`${title} ${desc}`);
  return _filters.some(k => n.includes(normalizeText(k)));
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
      description: desc ? desc.slice(0, 800) : null,
    });
  });

  return dedupeByUrl(items);
}

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(obj),
  };
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

  if (sourceKey === "nofluffjobs") {
    if (!url.startsWith("https://nofluffjobs.com/hu/job/")) return false;
    // szponzorált hirdetések más városokból is megjelenhetnek — csak budapest-i URL-eket engedünk
    const slug = u.pathname.replace("/hu/job/", "");
    if (!slug.includes("budapest")) return false;
  }

  if (sourceKey === "otp") {
    // csak a pozíció-oldalak kellenek, pl. /otp/job/Budapest-.../1234/
    if (!u.pathname.startsWith("/otp/job/")) return false;
  }

  if (sourceKey === "vizmuvek") {
    // csak a pozíció-aloldalak kellenek, pl. /hu/karrier/gyakornoki-dualis-kepzes/hr-gyakornok
    const base = "/hu/karrier/gyakornoki-dualis-kepzes/";
    if (!u.pathname.startsWith(base) || u.pathname === "/hu/karrier/gyakornoki-dualis-kepzes" || u.pathname === base) return false;
  }

  if (sourceKey === "onejob") {
    // csak a pozíció-oldalak kellenek, pl. /munka/szoftverfejleszto-gyakornok/
    if (!u.pathname.startsWith("/munka/") || u.pathname === "/munka/" || u.pathname === "/munka") return false;
  }

  if (sourceKey === "wherewework" && !(url.startsWith("https://www.wherewework.hu/en/jobs/") && /\/\d+$/.test(u.pathname))) return false;

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
// Melódiák SSR extraction
// =====================

// =====================
// Bundle debug for Melódiák API discovery
// =====================



// =====================
// DB upsert (csak write=1 esetén)
// =====================
async function upsertJob(client, source, item) {
  const canonicalUrl = normalizeUrl(item.url);
  await client.query(
    `INSERT INTO job_posts
      (source, title, url, canonical_url, experience, first_seen)
     VALUES ($1,$2,$3,$4,$5,NOW())
     ON CONFLICT (source, url)
     DO UPDATE SET
       title = EXCLUDED.title,
       canonical_url = EXCLUDED.canonical_url,
       experience = COALESCE(EXCLUDED.experience, job_posts.experience);`,
    [source, item.title, item.url, canonicalUrl, item.experience ?? "-"]
  );
}


function cleanJobTitle(rawTitle) {
  if (!rawTitle) return null;
  // Cut at 'ÚJ' or similar markers
  const cutMarkers = ["ÚJ", "NEW", "FRISS"]; // extend if needed
  let title = rawTitle;
  for (const marker of cutMarkers) {
    const idx = title.indexOf(marker);
    if (idx >= 0) {
      title = title.slice(0, idx);
      break;
    }
  }
  // Trim extra spaces and punctuation at the end
  return title.trim().replace(/[-–:]+$/g, "").trim();
}

// Example:

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
        await logFetchError("cron_jobs", { url: p.url, message: err.message });
        stats.portals.push({ source, label: p.label, url: p.url, ok: false, error: err.message });
        continue;
      }

      // =========================
      // MERGE JOBS
      // =========================
      let generic = extractCandidates(html, p.url).filter((c) => looksLikeJobUrl(source, c.url));
      let ssr = extractSSR(html, p.url).filter((c) => looksLikeJobUrl(source, c.url));
      let merged = mergeCandidates(generic, ssr);

      // =========================
      // FILTER & KEYWORD MATCH
      // =========================
      let matchedList = merged
        .map((c) => {
          if (source === "nofluffjobs") c.title = cleanJobTitle(c.title);
          return c;
        })
        .filter((c) => !isSeniorLike(c.title, c.description));



      // =========================
      // BLACKLISTING
      // =========================
      const BLACKLIST_SOURCES = [ "jobline", "otp","muisz"];
      const BLACKLIST_URLS = [
        "https://jobline.hu/allasok/25,200307,162",
        "https://karrier.otpbank.hu/go/Minden-allasajanlat/1167001/?q=",
        "https://muisz.hu/hu/regisztracio",
        "https://muisz.hu/hu/diakmunkaink",

      ];

      if (BLACKLIST_SOURCES.some(src => source.startsWith(src))) {
        matchedList = matchedList.filter(c => !BLACKLIST_URLS.includes(c.url));
      }


      stats.portals.push({ source, label: p.label, url: p.url, ok: true, matched: matchedList.length });

      // =========================
      // DB UPSERT
      // =========================
      if (write && client) {
        const DIAKMUNKA_SOURCES = ["otp", "vizmuvek"];
        for (const item of matchedList) {
          if (DIAKMUNKA_SOURCES.includes(source) || isInternshipTitle(item.title)) item.experience = "diákmunka";
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
  _filters = await loadFilters();
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


