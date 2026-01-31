// netlify/functions/cron_jobs.js
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




function extractZynternFromApiPayload(payload) {
  const arr = Array.isArray(payload?.data) ? payload.data : [];

  return arr
    .map((j) => ({
      title: j?.title ? String(j.title).slice(0, 300) : null,
      url: j?.url ? normalizeUrl(String(j.url)) : null,
      description: j?.description ? String(j.description).slice(0, 800) : null,
    }))
    .filter((x) => x.title && x.url);
}

async function fetchAllZynternJobs({ fields = 16, limit = 50, maxPages = 5 }) {
  let page = 1;
  let all = [];

  while (page <= maxPages) {
    const url = `https://zyntern.com/api/jobs?fields=${fields}&page=${page}&limit=${limit}`;
    const payload = await fetchJson(url);

    const items = extractZynternFromApiPayload(payload);
    if (!items.length) break;

    all.push(...items);

    // meta alapján is tudsz megállni
    const lastPage = Number(payload?.meta?.last_page || 0);
    if (lastPage && page >= lastPage) break;

    // ha nincs meta, fallback
    if (items.length < limit) break;

    page++;
  }

  return dedupeByUrl(all);
}



function normalizeUrl(raw) {
  try {
    const u = new URL(raw);

    // --- LINKEDIN FIX ---
    if (u.hostname.includes("linkedin.com") && u.pathname.startsWith("/jobs/view/")) {
      u.search = "";   // minden ?param törlése
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
  { key: "LinkedIn",label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?currentJobId=4194029806&f_E=1%2C2&f_TPR=r86400&geoId=100288700&origin=JOB_SEARCH_PAGE_JOB_FILTER&refresh=true&sortBy=R" },
  { key: "cvonline",  label:  "cvonline", url: "https://www.cvonline.hu/hu/allashirdetesek/it-informatika-0/budapest/apprenticeships?search=&job_geo_location=&radius=25&%C3%81ll%C3%A1skeres%C3%A9s=%C3%81ll%C3%A1skeres%C3%A9s&lat=&lon=&country=&administrative_area_level_1=" }
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
  "network"
];

const TITLE_BLACKLIST = [
  "marketing",
  "sales",
  "hr",
  "finance",
  "pénzügy",
  "könyvelő",
  "accountant",
  "manager",
  "vezető",
  "director",
  "adminisztráció",
  "asszisztens",
  "ügyfélszolgálat",
  "customer service",
  "call center",
  "értékesítő",
  "biztosítás",
  "tanácsadó",     // nem IT consultant, hanem business jellegű
];

function titleNotBlacklisted(title) {
  const t = normalizeText(title);
  return !TITLE_BLACKLIST.some(word => t.includes(normalizeText(word)));
}

const LINKEDIN_TITLE_WHITELIST = [
  "developer",
  "fejlesztő",
  "fejleszto",
  "software",
  "engineer",
  "data",
  "analyst",
  "qa",
  "tester",
  "devops",
  "cloud",
  "backend",
  "frontend",
  "fullstack",
  "it",
  "security",
  "network",
  "sysadmin",
];

function linkedinTitleAllowed(title) {
  const t = normalizeText(title);
  return LINKEDIN_TITLE_WHITELIST.some(word => t.includes(normalizeText(word)));
}

function isReallinkedinJobUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname.includes("linkedin.com") && u.pathname.startsWith("/jobs/view/");
  } catch {
    return false;
  }
}
  
function isRealCvonlineJobUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname.includes("cvonline.hu") && u.pathname.startsWith("/hu/allas/");
  } catch {
    return false;
  }
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

  // szabály:
  // - ha van strongHit → ok
  // - ha csak "it" van, az NEM elég (különben túl sok false positive)
  return strongHit || (itHit && /support|sysadmin|network|qa|tester|developer|data|analyst|operations|security|biztonsag|tanacsado|consultant/.test(n));
}

function extractSSR(html, baseUrl) {
  const $ = cheerio.load(html);
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

const SOURCE_ADAPTERS = {
  // zyntern már megvan nálad
  zyntern: {
    type: "api",
    fetch: async () => {
      const url = `https://zyntern.com/api/jobs?fields=16&page=1&limit=50`;
      const payload = await fetchJson(url);
      const arr = Array.isArray(payload?.data) ? payload.data : [];
      return arr.map(j => ({
        title: j?.title ? String(j.title).slice(0, 300) : null,
        url: j?.url ? normalizeUrl(String(j.url)) : null,
        description: j?.description ? String(j.description).slice(0, 800) : null,
      })).filter(x => x.title && x.url);
    }
  },

  // ide jönnek majd: mol, taboola, mediso, continental, kh, piller...
};


async function fetchJsonApi(url, redirectLeft = 5) {
  const txt = await fetchTextWithHeaders(url, {
    Accept: "application/json, text/plain, */*",
    "X-Requested-With": "XMLHttpRequest",
    Referer: "https://zyntern.com/jobs?fields=16",
  }, redirectLeft);
  return JSON.parse(txt);
}

function fetchTextWithHeaders(url, extraHeaders = {}, redirectLeft = 5) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;

    const req = lib.request(
      u,
      {
        method: "GET",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
          "Accept-Language": "hu-HU,hu;q=0.9,en;q=0.8",
          "Accept-Encoding": "gzip,deflate,br",
          ...extraHeaders,
        },
        timeout: 50000,
      },
      (res) => {
        const code = res.statusCode || 0;

        if ([301, 302, 303, 307, 308].includes(code)) {
          const loc = res.headers.location;
          if (!loc) return reject(new Error(`HTTP ${code} (no Location) for ${url}`));
          if (redirectLeft <= 0) return reject(new Error(`Too many redirects for ${url}`));
          const nextUrl = new URL(loc, url).toString();
          res.resume();
          return resolve(fetchTextWithHeaders(nextUrl, extraHeaders, redirectLeft - 1));
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

function extractMelodiakDetail(html, baseUrl) {
  const $ = cheerio.load(html);

  const title =
    normalizeWhitespace($("h1,h2").first().text()) ||
    normalizeWhitespace($(".job-title,.title").first().text()) ||
    null;

  // próbálunk “nagy” szöveget találni (leírás / elvárások / feladatok)
  const desc =
    normalizeWhitespace($(".job-description, .description, .content, .entry-content").text()) ||
    normalizeWhitespace($("main").text()) ||
    normalizeWhitespace($("body").text());

  return {
    title: title ? title.slice(0, 300) : null,
    description: desc ? desc.slice(0, 800) : null,
    url: normalizeUrl(baseUrl),
  };
}

async function enrichMelodiakItems(items, limit = 12) {
  // egyszerű soros futás (14 elemnél bőven ok, Netlify-n is biztonságos)
  const out = [];
  for (const it of items.slice(0, limit)) {
    try {
      const html = await fetchText(it.url);
      const d = extractMelodiakDetail(html, it.url);
      out.push({
        title: d.title || it.title,
        url: it.url,
        description: d.description || it.description || null,
      });
    } catch {
      out.push(it); // fallback
    }
  }
  // ha több mint limit, a maradékot változatlanul hozzáadjuk
  if (items.length > limit) out.push(...items.slice(limit));
  return out;
}


function looksLikeJobUrl(sourceKey, url) {
  if (!url) return false;
  const u = new URL(url);

  // általános szemét: login, account, category, tag, keresőoldal
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

  // CVCentrum: csak a konkrét hirdetés oldalak
  if (sourceKey.startsWith("cvcentrum")) {
    // jó: /allasok/<slug>/
    if (!/^\/allasok\/[^\/]+\/?$/.test(u.pathname)) return false;
  }

  if (sourceKey === "zyntern") {
    // csak a konkrét job oldalak
    if (!/^\/job\/\d+/.test(u.pathname)) return false;
  }


  // MUISZ-nál pl később lehet más szabály

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
  const $ = cheerio.load(html);
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
function extractMelodiakCards(html) {
  const $ = cheerio.load(html);
  const items = [];

  $(".job-list-item").each((_, el) => {
    const $el = $(el);

    const title =
      normalizeWhitespace($el.find(".job-title").first().text()) ||
      normalizeWhitespace($el.find("h1,h2,h3,h4,h5,h6").first().text());
    if (!title || title.length < 4) return;

    const cls = $el.attr("class") || "";
    const tokens = cls.split(/\s+/).filter(Boolean);

    const rawSlug =
      tokens.find((t) => t.startsWith("job-list-component-")) ||
      tokens.find((t) => /^[a-z0-9]+(?:-[a-z0-9]+){3,}$/i.test(t)) ||
      null;

    if (!rawSlug) return;

    const slug = rawSlug.replace(/^job-list-component-/, "");
    const url = `https://www.melodiak.hu/diakmunkak/${slug}/`;

    items.push({ title: title.slice(0, 300), url, description: null });
  });

  return dedupeByUrl(items);
}

// =====================
// Bundle debug for Melódiák API discovery
// =====================
function extractScriptSrcs(html, baseUrl) {
  const $ = cheerio.load(html);
  return $("script[src]")
    .map((_, s) => absolutize($(s).attr("src"), baseUrl))
    .get()
    .filter(Boolean);
}

function findBundleApiHints(jsText) {
  const hits = new Set();
  (jsText.match(/\/api\/[a-z0-9_\-\/]+/gi) || []).forEach((x) => hits.add(x));
  (jsText.match(/\/graphql\b/gi) || []).forEach((x) => hits.add(x));
  (jsText.match(/https?:\/\/[^"' ]+\/api\/[^"' ]+/gi) || []).forEach((x) => hits.add(x));
  (jsText.match(/\/(jobs?|works?|positions?|search)[a-z0-9_\-\/]*/gi) || [])
    .slice(0, 200)
    .forEach((x) => {
      if (x.length >= 6) hits.add(x);
    });

  return [...hits].slice(0, 80);
}

function bundleContextSamples(jsText, patterns, limit = 12) {
  const out = [];
  for (const p of patterns) {
    const idx = jsText.indexOf(p);
    if (idx >= 0) {
      const start = Math.max(0, idx - 80);
      const end = Math.min(jsText.length, idx + p.length + 80);
      out.push({ hit: p, context: jsText.slice(start, end) });
      if (out.length >= limit) break;
    }
  }
  return out;
}

function canonicalizeCvUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);

    // csak a cvcentrum.hu domainre alkalmazzuk
    if (u.hostname === "cvcentrum.hu" && u.pathname.startsWith("/allasok/")) {
      const slug = u.pathname.replace("/allasok/", "").replace(/\/$/, "");

      return `https://www.cvonline.hu/hu/allas/${slug}`;
    }

    return rawUrl;
  } catch {
    return rawUrl;
  }
}


// =====================
// DB upsert (csak write=1 esetén)
// =====================
async function upsertJob(client, source, item) {
  await client.query(
    `
    INSERT INTO job_posts
      (source, title, url, description, first_seen)
    VALUES
      ($1, $2, $3, $4, NOW())
    ON CONFLICT (source, url)
    DO UPDATE SET
      title = EXCLUDED.title,
      description = COALESCE(EXCLUDED.description, job_posts.description)
    `,
    [source, item.title, item.url, item.description]
  );
}



// =====================
// Handler (ONE RUN, FIRST 4 SOURCES)
// =====================
exports.handler = async (event) => {
  const qs = event.queryStringParameters || {};
  const debug = qs.debug === "1";
  const bundleDebug = qs.bundledebug === "1";
  const isDebug = qs.debug === "1";
  const write = qs.write === "1" || !isDebug;

  // ---- batching (cron + timeout védelem)
  const batch = Math.max(parseInt(qs.batch || "0", 10) || 0, 0);
  const size = Math.min(Math.max(parseInt(qs.size || "4", 10) || 4, 1), 8);

  const listToProcess = SOURCES.slice(batch * size, batch * size + size);

  const client = write ? await pool.connect() : null;

  const stats = {
    ok: true,
    node: process.version,
    ranAt: new Date().toISOString(),
    debug,
    bundleDebug,
    write,
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

      // Zynternnél később sem kell html, de a bundledebughoz hasznos lehet
      try {
        html = await fetchText(p.url);
      } catch (err) {
        stats.portals.push({ source, label: p.label, url: p.url, ok: false, error: err.message });
        continue;
      }

      // =========================
      //  MERGED KÉPZÉS (ITT A LÉNYEG)
      // =========================
      // =========================

      // 1️⃣ HTML alapú találatok
      let generic = extractCandidates(html, p.url).filter((c) =>
        looksLikeJobUrl(source, c.url)
      );

      let ssr = extractSSR(html, p.url).filter((c) =>
        looksLikeJobUrl(source, c.url)
      );

      // 2️⃣ Összefésülés + URL alapú deduplikálás
      let merged = mergeCandidates(generic, ssr);

      // 3️⃣ Keyword szűrés
      let matched = merged.filter((c) =>
        matchesKeywords(c.title, c.description)
      );

      // 4️⃣ Globális title blacklist
      matched = matched.filter((c) => titleNotBlacklisted(c.title));

      // 5️⃣ LinkedIn whitelist (csak IT jellegű címek maradnak)
      if (source === "LinkedIn") {
        matched = matched.filter(
          (c) => linkedinTitleAllowed(c.title) && isReallinkedinJobUrl(c.url)
        );
      }


      // 6️⃣ CVOnline – csak valódi álláshirdetés URL maradhat
      if (source === "cvonline") {
        matched = matched.filter((c) => isRealCvonlineJobUrl(c.url));
      }


      // =========================
      // MATCH + DEBUG REJECTED
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

      // =========================
      // DB UPSERT
      // =========================
      let upserted = 0;
        const upsertErrors = [];

        if (write && client) {
          for (const it of matched) {
            try {
              await upsertJob(client, source, it);
              upserted++;
            } catch (e) {
              upsertErrors.push({ title: it.title, url: it.url, error: e.message });
            }
          }
        }


      // =========================
      // PORTAL STAT
      // =========================
      const portalStat = {
        source,
        label: p.label,
        url: p.url,
        ok: true,
        counts: {
          // Zynternnél ezek nem értelmezettek úgy, mint HTML-nél
          generic: source === "zyntern" ? 0 : undefined,
          ssr: source === "zyntern" ? 0 : undefined,
          melodiakSSR: source === "melodiak" ? undefined : 0,
          merged: merged.length,
          matched: matched.length,
          upserted,
        },
      };

      if (debug) {
        portalStat.rejectedSample = rejected;
        if (upsertErrors.length) portalStat.upsertErrors = upsertErrors.slice(0, 10);
      }

      // =========================
      // bundle debug (melodiak + zyntern)
      // =========================
      if (debug && bundleDebug && (source === "melodiak" || source === "zyntern")) {
        const scriptSrcs = extractScriptSrcs(html, p.url);
        portalStat.scriptSrcs = scriptSrcs.slice(0, 25);

        const mainLike =
          scriptSrcs.find((s) => /main\..*\.js(\?|$)/i.test(s)) ||
          scriptSrcs.find((s) => /index\..*\.js(\?|$)/i.test(s)) ||
          scriptSrcs.find((s) => /runtime\..*\.js(\?|$)/i.test(s)) ||
          scriptSrcs.find((s) => /app\..*\.js(\?|$)/i.test(s)) ||
          scriptSrcs.find((s) => /\.js(\?|$)/i.test(s)) ||
          null;

        portalStat.mainBundle = mainLike || null;

        if (mainLike) {
          try {
            const jsText = await fetchText(mainLike);
            const bundleApiHints = findBundleApiHints(jsText);
            portalStat.bundleApiHints = bundleApiHints;
            portalStat.bundleSample = bundleContextSamples(jsText, bundleApiHints, 12);
          } catch (e) {
            portalStat.bundleError = e.message;
          }
        }
      }

      stats.portals.push(portalStat);
    }

    return json(200, stats);
  } catch (err) {
    console.error(err);
    return json(500, { ok: false, error: err.message, node: process.version });
  } finally {
    if (client) client.release();
  }
};


