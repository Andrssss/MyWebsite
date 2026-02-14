
// netlify/functions/cron_jobs.js
console.log("CRON_JOBS LOADED");
export const config = {
  schedule: "0 4,16 * * *",
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
  { key: "zyntern", label: "Zyntern – IT/fejlesztés", url: "https://zyntern.com/jobs?fields=16" },
  { key: "schonherz", label: "Schönherz – Budapest fejlesztő/tesztelő", url: "https://schonherz.hu/diakmunkak/budapest/fejleszto---tesztelo" },
  { key: "tudasdiak", label: "Tudasdiak", url: "https://tudatosdiak.anyway.hu/hu/jobs?searchIndustry%5B%5D=7&searchMinHourlyWage=1000" },
  { key: "otp", label: "OTP", url: "https://karrier.otpbank.hu/go/Minden-allasajanlat/1167001/?q=&q2=&alertId=&locationsearch=&title=GYAKORNOK&date=&location=&shifttype=" },
  { key: "vizmuvek",  label:  "vizmuvek", url: "https://www.vizmuvek.hu/hu/karrier/gyakornoki-dualis-kepzes" },
  { key: "wherewework", label: "wherewework", url: "https://www.wherewework.hu/en/jobs/budaors,budapest/bpo-services,health-services,other-services,others,pharmaceutical,horeca,itc,trade,agriculture,education" },
  { key: "wherewework", label: "wherewework", url: "https://www.wherewework.hu/en/jobs/student-internship,entry-level-2-years/budapest?page=1" },
  { key: "onejob", label: "onejob", url: "https://onejob.hu/munkaink/?job__category_spec=informatika&job__location_spec=budapest" },
  { key: "nofluffjobs", label: "nofluffjobs", url: "https://nofluffjobs.com/hu/budapest?utm_source=facebook&utm_medium=social_cpc&utm_campaign=hbp&utm_content=Instagram_Reels&utm_id=120239436336450697&utm_term=120239436336520697&fbclid=PAdGRleAP9v2xleHRuA2FlbQEwAGFkaWQBqy0hd5G9WXNydGMGYXBwX2lkDzEyNDAyNDU3NDI4NzQxNAABp-R_SE_c9O6KU5EqFghpD-ajuuKDtviyfnC4ISpI22VXvxQFO3UL-hd8sdBG_aem_9-6Oig3Ju0SERNEIrcg6kw&criteria=seniority%3Dtrainee,junior" },

  
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
  "tanácsadó",   
  "Adótanácsadó" ,
  "Auditor",
  "Accountant",
  "Accounts",
  "Tanácsadó"
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

  // 3) próbálkozás tipikus endpointokkal
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
      return token;
    }
  } catch (e) {
    console.log("[minddiak token] failed", c.method, c.url, e.message);
  }
}

    // 4) fallback: token keresése a main bundle-ben
    // 4) fallback: valós guest endpoint kinyerése a bundle-ből
  try {
    const t = await getMinddiakApiTokenFromBundle("https://minddiak.hu/diakmunka-226/work_type/it-mernok-10");
    if (t && isJwtStillValid(t)) {
      cached.token = t;
      const p = decodeJwtPayload(t);
      cached.exp = Number(p?.exp || 0);
      return t;
    }
  } catch (e) {
    console.log("[minddiak token] bundle guest fallback failed:", e.message);
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

  if (debug) console.log("[minddiak] count:", total, "pages:", pages);

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

    if (!items.length) break;
    all.push(...items);

    // ha nincs count, ez állítja meg
    if (items.length < limit) break;
  }

  return dedupeByUrl(all);
}



async function minddiakCount(where, token) {
  const candidates = [
    "https://api.humancentrum.hu/count",           // amit a DevTools mutat
    "https://api.humancentrum.hu/positions/count", // LoopBack klasszikus
  ];

  for (const base of candidates) {
    const u  = new URL("https://api.humancentrum.hu/positions/count");
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

  for (const attempt of [
    { method: "GET" },
    { method: "POST", body: {} },
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
      console.log("[minddiak token] bundle attempt failed:", attempt.method, e.message);
    }
  }

  return null;
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
  const $ = cheerioLoad(html);

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
function extractMelodiakCards(html) {
  const $ = cheerioLoad(html);

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
    status: 30,                 // ez nálad a probe-ban is 30
    date: today,                // UI is küld date-et
    work_type_md_id: [null, 10],// IT mérnök (a képed alapján)
    distance: 20,               // UI szerint
    county: [null, 13],         // Budapest (a képed alapján)
  };
}

// =====================
// DB upsert (csak write=1 esetén)
// =====================
async function upsertJob(client, source, item) {
  await client.query(
    `
    INSERT INTO job_posts
      (source, title, url, first_seen)
    VALUES
      ($1, $2, $3, NOW())
    ON CONFLICT (source, url)
    DO NOTHING;
    `,
    [source, item.title, item.url]
  );
}

function extractSchonherz(html, baseUrl) {
  const $ = cheerioLoad(html);

  const items = [];

  // 1 hirdetés = 1 darab .col-md-8 a #ads alatt
  $("#ads .row.ad-list .col-md-8").each((_, el) => {
    const $card = $(el);

    // URL: az első diakmunka link a kártyában
    const href = $card.find("a[href*='/diakmunka/']").first().attr("href");
    const url = href ? absolutize(href, baseUrl) : null;
    if (!url) return;

    // TITLE: preferáltan a h4-ben lévő link szövege (ez a valódi pozíció név)
    let title = normalizeWhitespace($card.find("h4 a[href*='/diakmunka/']").first().text());

    // fallback: ha nincs h4, akkor a leghosszabb nem-CTA link szöveg a kártyában
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

  return dedupeByUrl(items);
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
const raw = "German Speaking Junior Project Manager – Public Transport ÚJ 650k – 1.1M HUF Project Manager Communication skills Completed studies Decision-making skills Deutsche Telekom TSI Hungary Kft. Budapest +3";
console.log(cleanJobTitle(raw));
// Output: "German Speaking Junior Project Manager – Public Transport"


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
          merged = await fetchAllZynternJobs({ fields: 16, limit: 50, maxPages: 5 });
        } catch (e) {
          stats.portals.push({ source, label: p.label, url: p.url, ok: false, error: `Zyntern API error: ${e.message}` });
          continue;
        }
      } else if (source === "minddiak") {
        try {
          merged = await fetchMinddiakJobsFromApi({ limit: 50, maxPages: 6, debug });
        } catch (e) {
          stats.portals.push({ source, label: p.label, url: p.url, ok: false, error: `MindDiák API error: ${e.message}` });
          continue;
        }
      } else {
        let generic = extractCandidates(html, p.url).filter((c) => looksLikeJobUrl(source, c.url));
        let ssr = extractSSR(html, p.url).filter((c) => looksLikeJobUrl(source, c.url));

        let melodiakSSR = [];
        if (source === "melodiak") melodiakSSR = extractMelodiakCards(html).filter((c) => looksLikeJobUrl(source, c.url));

        let schonherz = [];
        if (source === "schonherz") schonherz = extractSchonherz(html, p.url);

        merged =
          source === "schonherz"
            ? mergeCandidates(schonherz, generic, ssr, melodiakSSR)
            : mergeCandidates(generic, ssr, melodiakSSR);

        if (source === "melodiak") merged = await enrichMelodiakItems(merged, 20);
      }

      // =========================
      // FILTER & KEYWORD MATCH
      // =========================
      let matchedList = merged
        .map((c) => {
          if (source === "nofluffjobs") c.title = cleanJobTitle(c.title);
          return c;
        })
        .filter((c) => matchesKeywords(c.title, c.description))
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
      if (write && client) {
        for (const item of matchedList) {
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


