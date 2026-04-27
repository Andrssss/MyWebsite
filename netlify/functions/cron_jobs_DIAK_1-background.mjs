// netlify/functions/cron_jobs_DIAK_1.mjs
console.log("CRON_JOBS_DIAK_1 LOADED");

/* =========================
const SOURCES = [
  { key: "minddiak", label: "Minddiák", url: "https://minddiak.hu/diakmunka-226/work_type/it-mernok-10" },
  { key: "muisz", label: "Muisz – gyakornoki kategória", url: "https://muisz.hu/hu/diakmunkaink?categories=3&locations=10" },
  { key: "zyntern", label: "Zyntern – IT/fejlesztés", url: "https://zyntern.com/jobs?fields=80,15,16" },
  { key: "schonherz", label: "Schönherz – Budapest fejlesztő/tesztelő", url: "https://schonherz.hu/diakmunkak/budapest/fejleszto---tesztelo" },
  { key: "tudasdiak", label: "Tudasdiak", url: "https://tudatosdiak.anyway.hu/hu/jobs?searchIndustry%5B%5D=7&searchMinHourlyWage=1000" },
];
*/


import https from "node:https";
import http from "node:http";
import zlib from "node:zlib";
import { load as cheerioLoad } from "cheerio";
import pkg from "pg";
const { Pool } = pkg;
import { loadFilters } from "./load_filters.mjs";
import { logFetchError, withTimeout } from "./_error-logger.mjs";

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


 
const _runStart = Date.now();
const TIME_BUDGET_MS = 26000; // stop starting new sources after 26s to avoid 29s timeout

function timeLeft() {
  return TIME_BUDGET_MS - (Date.now() - _runStart);
}

async function runAllBatches() {
  const size = 4;
  const totalBatches = Math.ceil(SOURCES.length / size);

  console.log("[runAllBatches]", totalBatches, "batches");

  for (let batch = 0; batch < totalBatches; batch++) {
    if (timeLeft() < 3000) {
      console.log(`[runAllBatches] skipping batch ${batch} – only ${(timeLeft() / 1000).toFixed(1)}s left`);
      break;
    }

    const stats = await runBatch({ batch, size, write: true, debug: false, bundleDebug: false });

    for (const p of stats.portals) {
      if (p.ok) {
        console.log(`[source:${p.source}] matched=${p.matched}`);
      } else {
        console.log(`[source:${p.source}] ERROR: ${p.error}`);
      }
    }

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

async function fetchJson(url, redirectLeft = 5) {
  const txt = await fetchText(url, redirectLeft);
  return JSON.parse(txt);
}


async function fetchAllZynternJobs({ fields = "80,15,16", maxPages = 10 }) {
  const all = [];

  for (let page = 1; page <= maxPages; page++) {
    const url = `https://zyntern.com/api/jobs?fields=${fields}&page=${page}`;

    let payload;
    try {
      payload = await fetchJson(url);
    } catch (err) {
      const msg = String(err?.message || "");
      if (/HTTP\s+404\b/i.test(msg)) break;
      throw err;
    }

    const pageItems = extractZynternFromApiPayload(payload);
    all.push(...pageItems);

    // stop if we reached the last page
    const meta = payload?.meta;
    if (meta && page >= (meta.last_page || page)) break;
    if (!pageItems.length) break;
  }

  return dedupeByUrl(all);
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
  { key: "minddiak", label: "Minddiák", url: "https://minddiak.hu/diakmunka-226/work_type/it-mernok-10" },
  { key: "muisz", label: "Muisz – gyakornoki kategória", url: "https://muisz.hu/hu/diakmunkaink?categories=3&locations=10" },
  { key: "zyntern", label: "Zyntern – IT/fejlesztés", url: "https://zyntern.com/jobs?fields=80,15,16" },
  { key: "schonherz", label: "Schönherz – Budapest fejlesztő/tesztelő", url: "https://schonherz.hu/diakmunkak/budapest/fejleszto---tesztelo" },
  { key: "tudasdiak", label: "Tudasdiak", url: "https://tudatosdiak.anyway.hu/hu/jobs?searchIndustry%5B%5D=7&searchMinHourlyWage=1000" },
];

// =====================
// Keywords
// =====================

function hasWord(n, w) {
  // szóhatár: it ne találjon bele más szavakba
  const re = new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  return re.test(n);
}




function base64urlDecode(str) {
  const pad = str.length % 4 ? "=".repeat(4 - (str.length % 4)) : "";
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/") + pad;
  return Buffer.from(b64, "base64").toString("utf8");
}

function decodeJwtPayload(token) {
  try {
    const parts = String(token || "").split(".");
    if (parts.length < 2) return null;
    return JSON.parse(base64urlDecode(parts[1]));
  } catch {
    return null;
  }
}
function fetchJsonWithHeaders(url, { method = "GET", headers = {}, body = null } = {}, redirectLeft = 5) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;

    const req = lib.request(
      u,
      {
        method,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
          "Accept-Language": "hu-HU,hu;q=0.9,en;q=0.8",
          "Accept-Encoding": "gzip,deflate,br",
          Accept: "application/json, text/plain, */*",
          ...headers,
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
          return resolve(fetchJsonWithHeaders(nextUrl, { method, headers, body }, redirectLeft - 1));
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
          if (code < 200 || code >= 300) return reject(new Error(`HTTP ${code} for ${url}. Body: ${data.slice(0, 200)}`));
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`JSON parse failed for ${url}: ${e.message}. Preview: ${data.slice(0, 200)}`));
          }
        });
        stream.on("error", reject);
      }
    );

    req.on("timeout", () => req.destroy(new Error(`Timeout for ${url}`)));
    req.on("error", reject);

    if (body) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}
function pickTokenFromPayload(payload) {
  if (!payload) return null;
  // gyakori mezőnevek
  return (
    payload.token ||
    payload.accessToken ||
    payload.access_token ||
    payload.jwt ||
    payload.data?.token ||
    payload.data?.accessToken ||
    payload.data?.access_token ||
    null
  );
}

async function getMinddiakApiToken() {
  
  // 1) cache
  const cached = globalThis.__minddiakTokenCache;
  if (cached?.token && isJwtStillValid(cached.token)) {
    const p = decodeJwtPayload(cached.token);
    return cached.token;
  }


  const envToken = process.env.MINDDIAK_API_BEARER;
  if (envToken && isJwtStillValid(envToken)) {
    cached.token = envToken;
    return envToken;
  }

  // 3) elsőként bundle extraction (ez nálad tipikusan működik)
  try {
    const t = await getMinddiakApiTokenFromBundle("https://minddiak.hu/diakmunka-226/work_type/it-mernok-10");
    if (t && isJwtStillValid(t)) {
      cached.token = t;
      const p = decodeJwtPayload(t);
      cached.exp = Number(p?.exp || 0);
      console.log("[minddiak token] SUCCESS: bundle extraction");
      return t;
    }
  } catch {
    // fallback a klasszikus endpoint próbákra
  }

  // 4) próbálkozás tipikus endpointokkal
  const candidates = [
    // GET
    { method: "GET", url: "https://api.humancentrum.hu/auth/guest" },
    { method: "GET", url: "https://api.humancentrum.hu/auth/token" },
    { method: "GET", url: "https://api.humancentrum.hu/session" },
    { method: "GET", url: "https://api.humancentrum.hu/users/guest" },

    // POST (néha kell)
    { method: "POST", url: "https://api.humancentrum.hu/auth/guest", body: {} },
    { method: "POST", url: "https://api.humancentrum.hu/auth/token", body: {} },
    { method: "POST", url: "https://api.humancentrum.hu/auth/login", body: { guest: true } },
  ];

  const commonHeaders = {
    Origin: "https://minddiak.hu",
    Referer: "https://minddiak.hu/",
  };

  for (const c of candidates) {
  try {
    const headers = { ...commonHeaders };

    if (c.method === "POST") {
      headers["Content-Type"] = "application/json";
    }

    const payload = await fetchJsonWithHeaders(
      c.url,
      {
        method: c.method,
        headers,
        body: c.body || null,
      }
    );

    const token = pickTokenFromPayload(payload);
    if (token && isJwtStillValid(token)) {
      cached.token = token;
      const p = decodeJwtPayload(token);
      cached.exp = Number(p?.exp || 0);
      console.log("[minddiak token] SUCCESS:", c.method, c.url);
      return token;
    }
  } catch (e) {
    // Silently skip failed attempts (typically 404/401 errors)
  }
}

  throw new Error("Could not obtain MindDiák API token automatically ...");

}

function isJwtStillValid(token, skewSeconds = 60) {
  const p = decodeJwtPayload(token);
  const exp = Number(p?.exp || 0);
  if (!exp) return false;
  const now = Math.floor(Date.now() / 1000);
  return exp > (now + skewSeconds);
}

function extractGuestEndpointFromBundle(jsText) {
  const idx = jsText.indexOf('key:"guest"');
  if (idx < 0) return null;

  const snippet = jsText.slice(idx, Math.min(jsText.length, idx + 8000));

  // key:"guest",value:function(){var Z="".concat(this.API_URL,"SOME_PATH");
  let m = snippet.match(/concat\(this\.API_URL,\s*"([^"]+)"\)/i);
  if (m?.[1]) return m[1];

  // this.API_URL+"SOME_PATH"
  m = snippet.match(/this\.API_URL\+\s*"([^"]+)"/i);
  if (m?.[1]) return m[1];

  // fallback: "/...guest..."
  m = snippet.match(/"\/[^"]*guest[^"]*"/i);
  if (m?.[0]) return JSON.parse(m[0]);

  return null;
}


function extractApiBaseFromBundle(jsText) {
  // keressünk konkrét humancentrum URL-t
  const m = jsText.match(/https?:\/\/api\.humancentrum\.hu\/[a-z0-9_\-\/]*/i);
  if (m?.[0]) {
    // biztos legyen / a végén
    return m[0].endsWith("/") ? m[0] : (m[0] + "/");
  }

  // fallback: sima domain
  return "https://api.humancentrum.hu/";
}

// Netlify warm instance cache
globalThis.__minddiakTokenCache ??= { token: null, exp: 0 };


async function fetchMinddiakJobsFromApi({ limit = 50, maxPages = 20, debug = false }) {
  const token = await getMinddiakApiToken();
  if (!token) throw new Error("MindDiák token missing");

  const where = buildMinddiakWhere_UI();

  // COUNT ha van, ha nincs, akkor lapozunk amíg elfogy
  const total = await minddiakCount(where, token);
  const pages = total == null ? maxPages : Math.min(Math.ceil(total / limit), maxPages);

  console.log(`[minddiak] count=${total ?? "?"}  pages=${pages}  limit=${limit}`);

  const all = [];
  for (let page = 0; page < pages; page++) {
    const offset = page * limit;

    const u = new URL("https://api.humancentrum.hu/positions");
    u.searchParams.set("order", "id DESC");
    u.searchParams.set("offset", String(offset));
    u.searchParams.set("limit", String(limit));
    u.searchParams.set("where", JSON.stringify(where));
    u.searchParams.set(
      "include",
      JSON.stringify([{ relation: "positionMd" }, { relation: "positionFrontend" }, { relation: "ownerUser" }])
    );

    const txt = await fetchTextWithHeaders(u.toString(), {
      Accept: "application/json, text/plain, */*",
      Authorization: `Bearer ${token}`,
      Referer: "https://minddiak.hu/",
      Origin: "https://minddiak.hu",
    });

    const payload = JSON.parse(txt);
    const arr = Array.isArray(payload) ? payload : (Array.isArray(payload?.data) ? payload.data : []);

    const items = arr
      .map((j) => {
        const title = j?.positionFrontend?.title || j?.title || j?.name || null;
        const url = buildMinddiakDetailUrl(j);


        const description =
          j?.positionFrontend?.short_description ||
          j?.positionFrontend?.description ||
          j?.description ||
          j?.companyDescription ||
          null;

        return {
          title: title ? String(title).slice(0, 300) : null,
          url: url || null,
          description: description ? String(description).slice(0, 800) : null,
        };
      })
      .filter((x) => x.title && x.url);

    console.log(`[minddiak] page ${page}: raw=${arr.length}  parsed=${items.length}`);
    if (!items.length) break;
    all.push(...items);

    // ha nincs count, ez állítja meg
    if (items.length < limit) break;
  }

  const deduped = dedupeByUrl(all);
  console.log(`[minddiak] fetchAllDone: total_raw=${all.length}  after_dedup=${deduped.length}`);
  return deduped;
}



async function minddiakCount(where, token) {
  const candidates = [
    "https://api.humancentrum.hu/count",           // amit a DevTools mutat
    "https://api.humancentrum.hu/positions/count", // LoopBack klasszikus
  ];

  for (const base of candidates) {
    const u  = new URL(base);
    u.searchParams.set("where", JSON.stringify(where));
    try {
      const txt = await fetchTextWithHeaders(u.toString(), {
        Accept: "application/json, text/plain, */*",
        Authorization: `Bearer ${token}`,
        Referer: "https://minddiak.hu/",
        Origin: "https://minddiak.hu",
      });
      const obj = JSON.parse(txt);
      const c = Number(obj?.count);
      if (Number.isFinite(c)) return c;
    } catch (e) {
      // csak log, megyünk tovább
      console.log("[minddiak count] failed:", u.toString(), e.message);
    }
  }

  return null; // nincs count endpoint -> lapozós fallback
}




async function getMinddiakApiTokenFromBundle(pageUrl) {
  const html = await fetchText(pageUrl);
  const scriptSrcs = extractScriptSrcs(html, pageUrl);

  const mainLike =
    scriptSrcs.find((s) => /main\..*\.js(\?|$)/i.test(s)) ||
    scriptSrcs.find((s) => /index\..*\.js(\?|$)/i.test(s)) ||
    null;

  if (!mainLike) return null;

  const jsText = await fetchText(mainLike);

  const guestPath = extractGuestEndpointFromBundle(jsText);
  if (!guestPath) return null;

  const apiBase = extractApiBaseFromBundle(jsText);

  const guestUrl = new URL(guestPath, apiBase).toString();

  const common = {
    Origin: "https://minddiak.hu",
    Referer: "https://minddiak.hu/",
    Accept: "application/json, text/plain, */*",
  };

  let lastError = null;
  for (const attempt of [
    { method: "POST", body: {} },
    { method: "GET" },
  ]) {
    try {
      const payload = await fetchJsonWithHeaders(
        guestUrl,
        {
          method: attempt.method,
          headers: {
            ...common,
            ...(attempt.method === "POST" ? { "Content-Type": "application/json" } : {}),
          },
          body: attempt.body || null,
        }
      );

      const token = pickTokenFromPayload(payload);
      if (token) return token;
    } catch (e) {
      lastError = e;
    }
  }

  if (lastError) {
    console.log("[minddiak token] bundle token request failed:", lastError.message);
  }

  return null;
}



function _blacklistRegex(k) {
  const norm = normalizeText(k);
  const escaped = norm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // szóhatár: csak teljes szóra/kifejezésre illeszkedjen
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i");
}

function matchesKeywords(title, desc) {
  const n = normalizeText(title ?? "");
  const hasBlacklistedWord = _filters.some((k) => _blacklistRegex(k).test(n));
  return !hasBlacklistedWord;
}

function findBlacklistHit(title, desc) {
  const n = normalizeText(title ?? "");
  return _filters.find((k) => _blacklistRegex(k).test(n)) || null;
}

function isSeniorLike(title = "", desc = "") {
  const n = normalizeText(title);
  return _filters.some(k => _blacklistRegex(k).test(n));
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
  for (const k of _filters) {
    const nk = normalizeText(k);
    if (n.includes(nk)) hits.push(k);
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



  if (sourceKey === "zyntern") {
    if (!/^\/job\/\d+/.test(u.pathname)) return false;
  }

  if (sourceKey === "muisz") {
    if (!normalizeUrl(url).startsWith("https://muisz.hu/hu/diakmunkaink/")) return false;
  }

  if (sourceKey === "tudasdiak") {
    if (!normalizeUrl(url).startsWith("https://tudatosdiak.anyway.hu/hu/jobs/")) return false;
  }

  if (sourceKey === "schonherz") {
    if (!normalizeUrl(url).startsWith("https://schonherz.hu/diakmunka/budapest/fejleszto---tesztelo/")) return false;
  }

  return true;
}


function buildMinddiakDetailUrl(j) {
  const id = j?.id ?? null;
  const pf = j?.positionFrontend || {};

  // MindDiák jellemző mezők
  const raw = (pf.url ?? pf.path ?? pf.link ?? pf.slug ?? "").toString().trim();

  // 1) ha már teljes URL
  if (/^https?:\/\//i.test(raw)) return normalizeUrl(raw);

  // 2) ha relatív útvonal (tipikusan "/diakmunka/...." vagy "diakmunka/....")
  if (raw) {
    let p = raw.split(/[?#]/)[0].trim();

    // rakjunk elé slash-t
    if (!p.startsWith("/")) p = "/" + p;

    // ha valamiért csak slug jönne "logisztikus-...-52079", akkor tegyük elé a /diakmunka/-t
    if (!p.startsWith("/diakmunka/") && !p.startsWith("/diakmunka-")) {
      // ha már tartalmaz id-t vagy slug-id formát, akkor is jó így
      p = "/diakmunka/" + p.replace(/^\/+/, "");
    }

    return normalizeUrl("https://minddiak.hu" + p);
  }

  // 3) fallback, ha nincs frontend path/url (utolsó mentsvár)
  if (id) return normalizeUrl(`https://minddiak.hu/diakmunka-${id}`);

  return null;
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
function extractScriptSrcs(html, baseUrl) {
  const $ = cheerioLoad(html);


  // ✅ Minddiák: base mindig root legyen
  let base = baseUrl;
  try {
    const u = new URL(baseUrl);
    base = u.origin + "/"; // https://minddiak.hu/
  } catch {}

  return $("script[src]")
    .map((_, s) => absolutize($(s).attr("src"), base))
    .get()
    .filter(Boolean);
}


function buildMinddiakWhere_UI() {
  const today = new Date().toISOString().slice(0, 10) + " 00:00:00";

  return {
    type: 20,
    status: 30,                 // aktív pozíciók
    date: today,                // csak a mai napon feladott állások
    work_type_md_id: [null, 10],// IT mérnök
    distance: 20,               // UI szerint
    county: [null, 13],         // Budapest
  };
}

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

function extractSchonherzFromHtml(html, baseUrl) {
  const $ = cheerioLoad(html);
  const items = [];

  $(".col-md-8").each((_, el) => {
    const $card = $(el);

    const href = $card.find("a[href*='/diakmunka/']").first().attr("href");
    const url = href ? absolutize(href, baseUrl) : null;
    if (!url) return;

    let title = normalizeWhitespace($card.find("h4 a[href*='/diakmunka/']").first().text());

    if (!title || title.length < 4) {
      const candidates = $card
        .find("a[href*='/diakmunka/']")
        .map((_, a) => normalizeWhitespace($(a).text()))
        .get()
        .filter((t) => t && t.length >= 4 && !isCtaTitle(t));

      candidates.sort((a, b) => b.length - a.length);
      title = candidates[0] || null;
    }

    if (!title || title.length < 4) return;

    items.push({
      title: title.slice(0, 300),
      url: normalizeUrl(url),
      description: null,
    });
  });

  return items;
}

function extractSchonherz(html, baseUrl) {
  return dedupeByUrl(extractSchonherzFromHtml(html, baseUrl));
}

async function fetchAllSchonherzJobs(initialHtml, baseUrl, { maxPages = 5 } = {}) {
  const all = extractSchonherzFromHtml(initialHtml, baseUrl);
  console.log(`[schonherz] page 0: ${all.length} items`);

  for (let page = 1; page <= maxPages; page++) {
    try {
      const body = JSON.stringify({
        office: "budapest",
        type: "fejleszto---tesztelo",
        text: "",
        current: page,
      });

      const ajaxHtml = await fetchSchonherzPage(
        "https://schonherz.hu/tobbdiakmunka/budapest/fejleszto---tesztelo",
        body
      );

      if (!ajaxHtml || ajaxHtml.trim().length === 0) break;

      const pageItems = extractSchonherzFromHtml(ajaxHtml, baseUrl);
      console.log(`[schonherz] page ${page}: ${pageItems.length} items`);

      if (!pageItems.length) break;
      all.push(...pageItems);
    } catch (err) {
      console.error(`[schonherz] page ${page} failed:`, err.message);
      break;
    }
  }

  return dedupeByUrl(all);
}

function fetchSchonherzPage(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;

    const req = lib.request(
      u,
      {
        method: "POST",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
          "Content-Type": "application/json; charset=UTF-8",
          Accept: "text/html, */*; q=0.01",
          "X-Requested-With": "XMLHttpRequest",
          "Accept-Encoding": "gzip,deflate,br",
          Referer: "https://schonherz.hu/diakmunkak/budapest/fejleszto---tesztelo",
        },
        timeout: 25000,
      },
      (res) => {
        const code = res.statusCode || 0;
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
    req.write(body);
    req.end();
  });
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

      if (timeLeft() < 3000) {
        console.log(`[runBatch] skipping ${source} – only ${(timeLeft() / 1000).toFixed(1)}s left`);
        stats.portals.push({ source, label: p.label, url: p.url, ok: false, error: "skipped: time budget exhausted" });
        continue;
      }

      const sourceStart = Date.now();
      console.log(`[source:${source}] START (${(timeLeft() / 1000).toFixed(1)}s left)`);

      let html = null;
      try {
        html = await fetchText(p.url);
      } catch (err) {
        await logFetchError("cron_jobs_DIAK_1", { url: p.url, message: err.message });
        stats.portals.push({ source, label: p.label, url: p.url, ok: false, error: err.message });
        continue;
      }

      // -------- bundle debug -------
      if (source === "minddiak" && debug && bundleDebug) {
        try {
          const scriptSrcs = extractScriptSrcs(html, p.url);
          const mainLike =
            scriptSrcs.find((s) => /main\..*\.js(\?|$)/i.test(s)) ||
            scriptSrcs.find((s) => /index\..*\.js(\?|$)/i.test(s)) ||
            scriptSrcs.find((s) => /runtime\..*\.js(\?|$)/i.test(s)) ||
            scriptSrcs.find((s) => /app\..*\.js(\?|$)/i.test(s)) ||
            scriptSrcs.find((s) => /\.js(\?|$)/i.test(s)) ||
            null;

          if (mainLike) {
            const jsText = await fetchText(mainLike);
            const guestPath2 = extractGuestEndpointFromBundle(jsText);
            const apiBase2 = extractApiBaseFromBundle(jsText);
            console.log("[minddiak bundledebug] apiBase:", apiBase2, "guestPath:", guestPath2);
          }
        } catch (e) {
          console.log("minddiak bundledebug error:", e.message);
        }
      }



      // =========================
      // MERGE JOBS
      // =========================
      let merged = [];

      if (source === "zyntern") {
        try {
          merged = await fetchAllZynternJobs({ fields: "80,15,16", maxPages: 10 });
        } catch (e) {
          await logFetchError("cron_jobs_DIAK_1", { url: p.url, message: `Zyntern API error: ${e.message}` });
          stats.portals.push({ source, label: p.label, url: p.url, ok: false, error: `Zyntern API error: ${e.message}` });
          continue;
        }
      } else if (source === "minddiak") {
        try {
          merged = await fetchMinddiakJobsFromApi({ limit: 50, maxPages: 20, debug });
          console.log(`[minddiak] fetched=${merged.length}`);
        } catch (e) {
          await logFetchError("cron_jobs_DIAK_1", { url: p.url, message: `MindDiák API error: ${e.message}` });
          stats.portals.push({ source, label: p.label, url: p.url, ok: false, error: `MindDiák API error: ${e.message}` });
          continue;
        }
      } else if (source === "schonherz") {
        try {
          merged = await fetchAllSchonherzJobs(html, p.url);
        } catch (e) {
          await logFetchError("cron_jobs_DIAK_1", { url: p.url, message: `Schönherz pagination error: ${e.message}` });
          stats.portals.push({ source, label: p.label, url: p.url, ok: false, error: `Schönherz pagination error: ${e.message}` });
          continue;
        }
      } else {
        let generic = extractCandidates(html, p.url).filter((c) => looksLikeJobUrl(source, c.url));
        let ssr = extractSSR(html, p.url).filter((c) => looksLikeJobUrl(source, c.url));
        merged = mergeCandidates(generic, ssr);
      }

      // =========================
      // FILTER & KEYWORD MATCH
      // =========================
      let matchedList;
      if (source === "minddiak") {
        matchedList = [];
        for (const c of merged) {
          // minddiaknál csak a címre szűrünk – a description gyakran tartalmaz
          // ártatlan cégleírás-szavakat (pl. "support", "hr"), ami false positive-ot okoz
          const hit = findBlacklistHit(c.title, "");
          if (hit) {
            console.log(`[minddiak] SKIP "${c.title}"  ← blacklist hit: "${hit}"`);
          } else {
            matchedList.push(c);
          }
        }
        console.log(`[minddiak] after_filter=${matchedList.length}  skipped=${merged.length - matchedList.length}`);
      } else {
        matchedList = merged
          .filter((c) => matchesKeywords(c.title, c.description))
          .filter((c) => !isSeniorLike(c.title, c.description));
      }



      // =========================
      // BLACKLISTING
      // =========================
      const BLACKLIST_SOURCES = ["muisz"];
      const BLACKLIST_URLS = [
        "https://muisz.hu/hu/regisztracio",
        "https://muisz.hu/hu/diakmunkaink",
      ];

      if (BLACKLIST_SOURCES.some(src => source.startsWith(src))) {
        matchedList = matchedList.filter(c => !BLACKLIST_URLS.includes(c.url));
      }

      const sourceDur = ((Date.now() - sourceStart) / 1000).toFixed(1);
      stats.portals.push({ source, label: p.label, url: p.url, ok: true, matched: matchedList.length, durationS: sourceDur });
      console.log(`[source:${source}] DONE in ${sourceDur}s – matched=${matchedList.length}`);

      // =========================
      // DB UPSERT
      // =========================
      if (write && client) {
        let saved = 0;
        for (const item of matchedList) {
          item.experience = "diákmunka";
          try {
            await upsertJob(client, source, item);
            if (source === "minddiak") console.log(`[minddiak] SAVED: "${item.title}"  url=${item.url}`);
            saved++;
          } catch (e) {
            if (source === "minddiak") console.log(`[minddiak] SAVE_ERR: "${item.title}"  err=${e.message}`);
          }
        }
        if (source === "minddiak") console.log(`[minddiak] db_saved=${saved}/${matchedList.length}`);
      } else if (source === "minddiak") {
        console.log(`[minddiak] write=false, would save ${matchedList.length} items`);
      }
    }
  } finally {
    if (client) client.release();
  }

  return stats;
}


const _runJob = withTimeout("cron_jobs_DIAK_1-background", async (request) => {
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
});

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  const expected = process.env.CRON_SECRET;
  if (!expected || token !== expected) {
    return new Response("Unauthorized", { status: 401 });
  }
  return _runJob(request);
};



