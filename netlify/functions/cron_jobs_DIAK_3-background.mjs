// netlify/functions/cron_jobs.mjs
// netlify/functions/cron_jobs.js
console.log("CRON_JOBS LOADED");

/* =========================
const SOURCES = [
  { key: "otp", label: "OTP", url: "https://karrier.otpbank.hu/search/?searchby=location&createNewAlert=false&q=&locationsearch=Budapest&geolocation=&optionsFacetsDD_city=&optionsFacetsDD_customfield1=&optionsFacetsDD_customfield2=Informatika+%C3%A9s+digitaliz%C3%A1ci%C3%B3&optionsFacetsDD_title=&_gl=1*1tielcj*_up*MQ..*_ga*MTczNTU5MDI1Ni4xNzgwMzI1MTQ2*_ga_MS48V6C7P1*czE3ODAzMjUxNDYkbzEkZzAkdDE3ODAzMjUxNDYkajYwJGwwJGgw"},
  { key: "vizmuvek",  label:  "vizmuvek", url: "https://www.vizmuvek.hu/hu/karrier/gyakornoki-dualis-kepzes" },
  { key: "wherewework", label: "wherewework", url: "https://www.wherewework.hu/en/jobs/budaors,budapest/bpo-services,health-services,other-services,others,pharmaceutical,horeca,itc,trade,agriculture,education" },
  { key: "wherewework", label: "wherewework", url: "https://www.wherewework.hu/en/jobs/student-internship,entry-level-2-years/budapest?page=1" },
  { key: "onejob", label: "onejob", url: "https://onejob.hu/munkaink/?job__category_spec=informatika&job__location_spec=budapest" },
  { key: "miszisz", label: "MISZISZ", url: "https://miszisz.hu/?post_type%5B%5D=munkaink&s=&mmin=0&mmax=8000&mvaros%5B%5D=0&mvaros%5B%5D=2&mvaros%5B%5D=3&mvaros%5B%5D=4&mvaros%5B%5D=6&mvaros%5B%5D=7&mvaros%5B%5D=8&mvaros%5B%5D=9&mvaros%5B%5D=10&mvaros%5B%5D=11&mvaros%5B%5D=12&mvaros%5B%5D=15&mvaros%5B%5D=17&mvaros%5B%5D=21&mvaros%5B%5D=68&mvaros%5B%5D=69&mvaros%5B%5D=368&mkat%5B%5D=231&mkat%5B%5D=40&mkat%5B%5D=257&mkat%5B%5D=41" },
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
import { logFetchError, withTimeout } from "./_error-logger.mjs";
import { reconcileActive, migrateVolatileUrl } from "./_active_core.mjs";
import { extractBodyExperience, extractTechnologies, ensureTechnologiesColumn, INTERNSHIP_KEYWORDS, isInternshipTitle, isJuniorTitle, isMidLevelTitle, isSeniorExperience } from "./_experience_core.mjs";

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
  // FIGYELEM: az azonos key-jű forrás-csoportnak (otp×5 = 2 bucket + 3 lista)
  // EGY batchben kell maradnia — a foundBySource batch-lokális, két batchre
  // esve a két reconcile egymás sorait deaktiválná/reaktiválná.
  const size = 5;
  const totalBatches = Math.ceil(SOURCES.length / size);

  console.log(`[runAllBatches] START – ${SOURCES.length} forrás, ${totalBatches} batch (méret: ${size})`);

  for (let batch = 0; batch < totalBatches; batch++) {
    console.log(`\n[runAllBatches] ▶ Batch ${batch + 1}/${totalBatches} fut...`);
    const result = await runBatch({ batch, size, write: true, debug: false, bundleDebug: false });
    const summary = result.portals.map(p => `  ${p.ok ? '✓' : '✗'} ${p.label} → ${p.ok ? p.matched + ' db' : p.error}`).join('\n');
    console.log(`[runAllBatches] Batch ${batch + 1} kész:\n${summary}`);
    await sleep(500);
  }

  console.log('[runAllBatches] MINDEN BATCH KÉSZ.');
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

// OTP (SuccessFactors) — a /job/{slug}/{reqId}/ url-ben a reqId a STABIL rész,
// a slug dekoratív és driftel (cím-szerkesztés, "-1131" lokáció-kód, encoding,
// sőt a path-prefix is változott már: /job/ ↔ /otp/job/). DB-bizonyíték: azonos
// reqId két különböző slug alatt. A minta ugyanazt a reqId-t találja meg
// bármilyen slug/prefix alatt, így migrateVolatileUrl a régi sort átnevezi az
// aktuális url-re deaktiválás + duplikátum helyett.
const VOLATILE_URL_PATTERNS = {
  otp: (url) => {
    const m = url.match(/^https:\/\/karrier\.otpbank\.hu(?:\/otp|\/leanyvallalatok)?\/job\/[^/]+\/(\d+)\/?$/);
    return m ? `^https://karrier\\.otpbank\\.hu(/otp|/leanyvallalatok)?/job/[^/]+/${m[1]}/?$` : null;
  },
};

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

  // OTP BUCKET-nézetek (bucketOnly): a TELJES élő listing megy a reconcile
  // foundUrls-ébe, upsert NÉLKÜL — így a 3 kategória-listán kívüli, korábban
  // ingestelt élő sorok nem deaktiválódnak, sőt a reconcile reaktivációja
  // vissza is kapcsolja őket (RPA fejlesztő / Modell Validációs gyakornok
  // osztályú téves lejáratások, 2026-07-07). Mérés: a Budapest-szűrős kereső
  // 93, a szűretlen 113 állás, és EGYIK SEM superset — pl. Modell Validációs
  // csak a Budapest-nézetben, LiveOps gyakornok / CBS Domain Architect csak a
  // szűretlenben látszik → mindkét nézet kell. (A szűretlen nézet CSAK
  // referencedate-rendezéssel lapozható stabilan; anélkül a sorok lapkérések
  // között csúszkálnak és állások maradnak ki — kétszer futtatva igazolva.)
  { key: "otp", label: "OTP bucket (Budapest)", bucketOnly: true, url: "https://karrier.otpbank.hu/search/?searchby=location&createNewAlert=false&q=&locationsearch=Budapest&geolocation=&optionsFacetsDD_city=&optionsFacetsDD_customfield1=&optionsFacetsDD_customfield2=&optionsFacetsDD_title=" },
  { key: "otp", label: "OTP bucket (teljes)", bucketOnly: true, url: "https://karrier.otpbank.hu/search/?q=&sortColumn=referencedate&sortDirection=desc" },
  { key: "otp", label: "OTP", url: "https://karrier.otpbank.hu/search/?searchby=location&createNewAlert=false&q=di%C3%A1kmunka&locationsearch=Budapest&geolocation=&optionsFacetsDD_city=&optionsFacetsDD_customfield1=&optionsFacetsDD_customfield2=&optionsFacetsDD_title=" },
    { key: "otp", label: "OTP", url: "https://karrier.otpbank.hu/search/?searchby=location&createNewAlert=false&q=&locationsearch=Budapest&geolocation=&optionsFacetsDD_city=Budapest&optionsFacetsDD_customfield1=&optionsFacetsDD_customfield2=Üzletfejlesztés+és+innováció&optionsFacetsDD_title=&_gl=1*eqovvy*_up*MQ..*_ga*NDIyODM3NjU3LjE3ODAzMjUzMDY.*_ga_MS48V6C7P1*czE3ODAzMjUzMDYkbzEkZzEkdDE3ODAzMjU0MTgkajE0JGwwJGgw"},
  { key: "otp", label: "OTP", url: "https://karrier.otpbank.hu/search/?searchby=location&createNewAlert=false&q=&locationsearch=Budapest&geolocation=&optionsFacetsDD_city=Budapest&optionsFacetsDD_customfield1=&optionsFacetsDD_customfield2=Informatika+és+digitalizáció&optionsFacetsDD_title=&_gl=1*1xvjrq1*_up*MQ..*_ga*MTA2NjU1MTQ3NS4xNzc5ODA3OTk5*_ga_MS48V6C7P1*czE3Nzk4MDc5OTkkbzEkZzAkdDE3Nzk4MDc5OTkkajYwJGwwJGgw" },
  { key: "vizmuvek",  label:  "vizmuvek", url: "https://www.vizmuvek.hu/hu/karrier/gyakornoki-dualis-kepzes" },
  // wherewework (2026-07-11): a city-only path (…/budaors,budapest) a site újabb
  // router-változása után már NEM szűkít városra — 748 találat / 75 oldal
  // (07-07-én még ~94 volt). Ingest-forrásnak használhatatlan: a job_filters
  // 324 címet átengedne, ebből 303 új, zömmel nem-IT (credit controller,
  // invoicing specialist stb.). Ezért BUCKET-ONLY (otp-minta): minden url a
  // reconcile foundUrls-ébe megy — életben tartja / reaktiválja a korábban
  // ingestelt sorokat —, de nem ingestel. Ingest csak az intern/entry-level
  // listából. (A kategória-path — pl. /itc — újra él, de a Bosch a mérnök-IT
  // posztjait "Industrial Production" alá sorolja, így az itc-lista a meglévő
  // sorainkat NEM fedné — élőben ellenőrizve: 0/21 találat.)
  { key: "wherewework", label: "wherewework bucket (széles)", bucketOnly: true, url: "https://www.wherewework.hu/en/jobs/budaors,budapest" },
  { key: "wherewework", label: "wherewework", url: "https://www.wherewework.hu/en/jobs/student-internship,entry-level-2-years/budapest?page=1" },
  { key: "onejob", label: "onejob", url: "https://onejob.hu/munkaink/?job__category_spec=informatika&job__location_spec=budapest" },
  { key: "miszisz", label: "MISZISZ", url: "https://miszisz.hu/?post_type%5B%5D=munkaink&s=&mmin=0&mmax=8000&mvaros%5B%5D=0&mvaros%5B%5D=2&mvaros%5B%5D=3&mvaros%5B%5D=4&mvaros%5B%5D=6&mvaros%5B%5D=7&mvaros%5B%5D=8&mvaros%5B%5D=9&mvaros%5B%5D=10&mvaros%5B%5D=11&mvaros%5B%5D=12&mvaros%5B%5D=15&mvaros%5B%5D=17&mvaros%5B%5D=21&mvaros%5B%5D=68&mvaros%5B%5D=69&mvaros%5B%5D=368&mkat%5B%5D=231&mkat%5B%5D=40&mkat%5B%5D=257&mkat%5B%5D=41" },
  // nofluffjobs → áttéve: cron_jobs_NOFLUFFJOBS-background.mjs
];

// A blacklistes url-t se az upsert, se a bucket ne lássa — különben a
// reconcile reaktiválná a kézzel kigyomlált sorokat.
const BLACKLIST_SOURCES = ["jobline", "otp", "muisz"];
const BLACKLIST_URLS = [
  "https://jobline.hu/allasok/25,200307,162",
  "https://karrier.otpbank.hu/go/Minden-allasajanlat/1167001/?q=",
  "https://muisz.hu/hu/regisztracio",
  "https://muisz.hu/hu/diakmunkaink",
  "https://karrier.otpbank.hu/otp/job/Budapest-Gyakornok-V%C3%A1llalati-Sz%C3%A1mlavezet%C3%A9si-K%C3%B6zpont-1051-Budapest-N%C3%A1dor-utca-6_-1051/1366316233/",
];

// =====================
// Keywords (INTERNSHIP_KEYWORDS / isInternshipTitle imported from _experience_core.mjs)
// =====================





function _blacklistRegex(k) {
  const escaped = normalizeText(k).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i");
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

  if (sourceKey === "otp") {
    // pozíció-oldalak: /otp/job/... vagy leányvállalati /leanyvallalatok/job/...
    if (!u.pathname.startsWith("/otp/job/") && !u.pathname.startsWith("/leanyvallalatok/job/")) return false;
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

  if (sourceKey === "miszisz") {
    // MISZISZ detail pages are under /munkaink/<slug>/
    if (!url.startsWith("https://miszisz.hu/munkaink/")) return false;
    if (u.pathname === "/munkaink/" || u.pathname === "/munkaink") return false;
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
    if (headingText && !isCtaTitle(headingText) && (isCtaTitle(linkText) || linkText.length > headingText.length + 15)) {
      title = headingText;
    }

    title = normalizeWhitespace(title);
    if (!title || title.length < 4) return;

    const desc =
      normalizeWhitespace(card.find("p").first().text()) ||
      normalizeWhitespace(card.find(".description, .job-desc, .job-description").first().text()) ||
      null;

    const company =
      normalizeWhitespace($(el).find('[class*="company-name"]').first().text()) ||
      normalizeWhitespace(card.find('[class*="company-name"]').first().text()) ||
      // wherewework: a kártyán a cégnév a céges /overview-... linkbe ágyazott h5-ben van
      normalizeWhitespace(card.find('a[href*="/overview-"] h5').first().text()) ||
      null;

    items.push({
      title: title.slice(0, 300),
      url,
      description: desc ? desc.slice(0, 800) : null,
      company: company ? company.slice(0, 200) : null,
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
  // Insert-only, kivétel nélkül (user-szabály, LinkedInen kívül sehol nincs
  // utólagos UPDATE): a sor insert előtt épül fel teljesen, a konfliktus
  // esetén a meglévő sor változatlan marad.
  await client.query(
    `INSERT INTO job_posts
      (source, title, url, experience, company, technologies, first_seen)
     VALUES ($1,$2,$3,$4,$5,$6,NOW())
     ON CONFLICT (source, url) DO NOTHING;`,
    [source, item.title, item.url, item.experience ?? "-", item.company || null, item.technologies ?? null]
  );
}


// Let\u00f6lti a hirdet\u00e9s-oldalt \u00e9s kiolvassa, h\u00e1ny \u00e9vet v\u00e1rnak el a t\u00f6rzssz\u00f6vegb\u0151l.
// (wherewework + otp "egy\u00e9b" \u00e1gon haszn\u00e1ljuk.)
async function fetchDetailExperience(url) {
  try {
    const html = await fetchText(url);
    const normalizedHtml = html.replace(/\u2013/g, "-").replace(/\u2014/g, "-");
    return {
      experience: extractBodyExperience(normalizedHtml) || null,
      technologies: extractTechnologies(normalizedHtml),
    };
  } catch (err) {
    await logFetchError("cron_jobs_DIAK_3", { url, message: `detail experience: ${err.message}` });
    return { experience: null, technologies: null };
  }
}

// A wherewework kártyán a cím VÉGÉN ott a feladás dátuma ("Backend Engineer
// (Node.js) 2026. 07. 09."), és eddig így is mentettük. Emiatt egy dátum-alakú
// blacklist-szó (a job_filters-ben tényleg volt "2026. 07. 09." és "2026. 07. 10.")
// EGY EGÉSZ NAP termését kiszűrte, pozíciótól függetlenül — 2026-07-14-én 597
// hirdetés, köztük 205 valódi fejlesztői állás (lásd BLACKLIST_AUDIT.md).
// A dátumot a cím ELEJÉN levágjuk, még a blacklist-ellenőrzés előtt, hogy ez
// szerkezetileg se fordulhasson elő újra.
function cleanWhereweworkTitle(rawTitle) {
  if (!rawTitle) return null;
  return normalizeWhitespace(rawTitle).replace(/\s*\d{4}\.\s*\d{2}\.\s*\d{2}\.\s*$/, "").trim();
}

function cleanMisziszListTitle(rawTitle) {
  if (!rawTitle) return null;

  let title = normalizeWhitespace(rawTitle);
  const colonIdx = title.indexOf(":");
  if (colonIdx >= 0) {
    title = title.slice(0, colonIdx).trim();
  }

  const descMarker = title.match(/\s+Di[aá]kmunka\s*:/i);
  if (descMarker && typeof descMarker.index === "number") {
    title = title.slice(0, descMarker.index).trim();
  }

  title = title.replace(/^(?:di[aá]kmunka|gyakornok|mel[oó]di[aá]k|informatika|programoz[oó])\s+/i, "");
  return normalizeWhitespace(title) || null;
}

async function fetchMisziszTitle(url, fallbackTitle = null) {
  try {
    const html = await fetchText(url);
    const $ = cheerioLoad(html);

    const h1 = normalizeWhitespace($("h1").first().text());
    if (h1) return h1;

    const ogTitle = normalizeWhitespace($("meta[property='og:title']").attr("content"));
    if (ogTitle) return ogTitle;

    const pageTitle = normalizeWhitespace($("title").first().text())
      .replace(/\s*[|\-\u2013\u2014]\s*MISZISZ.*$/i, "")
      .trim();
    if (pageTitle) return pageTitle;
  } catch (err) {
    await logFetchError("cron_jobs_DIAK_3", { url, message: `miszisz title: ${err.message}` });
  }

  return cleanMisziszListTitle(fallbackTitle);
}

// ✅ Fixed runBatch()
async function runBatch({ batch, size, write, debug = false, bundleDebug = false }) {
  const listToProcess = SOURCES.slice(batch * size, batch * size + size);

  const client = write ? await pool.connect() : null;
  if (client) await ensureTechnologiesColumn(client);

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

  // Accumulate foundUrls per source key across all URLs — reconcile once per key after the loop.
  // Without this, multiple URLs with the same key (e.g. 3x "otp") would each call reconcileActive
  // and each subsequent call would deactivate what the previous call had just activated.
  const foundBySource = new Map(); // key -> { urls: string[], allSucceeded: boolean }

  try {
    for (const p of listToProcess) {
      const source = p.key;
      const tag = `[${source}]`;

      console.log(`\n${tag} ── ${p.label} ──`);
      console.log(`${tag}   URL: ${p.url}`);

      // initialize source entry (mark incomplete on fetch failure)
      if (!foundBySource.has(source)) foundBySource.set(source, { urls: [], allSucceeded: true });

      let html = null;
      try {
        html = await fetchText(p.url);
        console.log(`${tag}   Fetch OK – ${html.length} karakter`);
      } catch (err) {
        console.log(`${tag}   Fetch HIBA: ${err.message}`);
        await logFetchError("cron_jobs_DIAK_3", { url: p.url, message: err.message });
        stats.portals.push({ source, label: p.label, url: p.url, ok: false, error: err.message });
        foundBySource.get(source).allSucceeded = false;
        continue;
      }

      // =========================
      // MERGE JOBS
      // =========================
      const _rawGeneric = extractCandidates(html, p.url);
      let generic = _rawGeneric.filter((c) => looksLikeJobUrl(source, c.url));
      const _rawSsr = extractSSR(html, p.url);
      let ssr = _rawSsr.filter((c) => looksLikeJobUrl(source, c.url));
      console.log(`${tag}   extractCandidates: ${_rawGeneric.length} link → ${generic.length} job-like`);
      console.log(`${tag}   extractSSR:        ${_rawSsr.length} link → ${ssr.length} job-like`);
      let merged = mergeCandidates(generic, ssr);
      console.log(`${tag}   merged (dedupe): ${merged.length}`);

      // Paginate wherewework (follows [rel="next"] links until exhausted; page cap against infinite loops).
      // A "We are sorry you didn't find the job..." szöveg NEM stop-jel: minden
      // list-oldalon szerepel (találatokkal teli oldalon is — élőben igazolva
      // 2026-07-07), template-zaj. A korábbi marker-check a 2. oldal fetch-e
      // után azonnal megállt → csak az 1. oldal 10 állása került a foundUrls-be,
      // és a reconcile a 2+. oldalra csúszott élő állásokat tévesen deaktiválta
      // (pl. jarmuszimulacios-mernok-gyakornok/172590). Stop-jelek: nincs
      // rel=next, vagy az oldal 0 új job-url-t ad.
      if (source === "wherewework") {
        let pageHtml = html;
        let pageUrl = p.url;
        // 90 oldal ≈ 900 állás — a széles bucket-lista ma 75 oldal (748 állás).
        let safetyPagesLeft = 90;
        let pageNum = 1;
        let sawEnd = false;
        while (safetyPagesLeft-- > 0) {
          const $pg = cheerioLoad(pageHtml);
          const nextHref = $pg('[rel="next"]').attr("href");
          if (!nextHref) { console.log(`${tag}   wherewework: nincs több oldal (${pageNum} oldal után)`); sawEnd = true; break; }
          const nextUrl = absolutize(nextHref, pageUrl);
          if (!nextUrl) break; // értelmezhetetlen next-href → a lista vége hiányozhat, a cap-guard jelzi
          pageNum++;
          console.log(`${tag}   wherewework: oldal ${pageNum} → ${nextUrl}`);
          try {
            pageHtml = await fetchText(nextUrl);
          } catch (err) {
            console.log(`${tag}   wherewework oldal ${pageNum} HIBA: ${err.message}`);
            await logFetchError("cron_jobs_DIAK_3", { url: nextUrl, message: err.message });
            // részleges lista → a reconcile nem deaktiválhat belőle
            foundBySource.get(source).allSucceeded = false;
            sawEnd = true; // a hibát már jelöltük, a cap-guard ne írja felül a logot
            break;
          }
          const pgGeneric = extractCandidates(pageHtml, nextUrl).filter((c) => looksLikeJobUrl(source, c.url));
          const pgSsr = extractSSR(pageHtml, nextUrl).filter((c) => looksLikeJobUrl(source, c.url));
          const prevCount = merged.length;
          merged = mergeCandidates(merged, pgGeneric, pgSsr);
          console.log(`${tag}   wherewework oldal ${pageNum}: +${merged.length - prevCount} új (összesen: ${merged.length})`);
          if (merged.length === prevCount) { console.log(`${tag}   wherewework: 0 új url az oldalon – megáll`); sawEnd = true; break; }
          pageUrl = nextUrl;
          await sleep(300);
        }
        // Cap úgy merült ki, hogy volt még rel=next → a listing csonka lehet;
        // részleges lista alapján a reconcile nem deaktiválhat. (2026-07-10 körül
        // a 25-ös cap + hiányzó guard pont így deaktivált tévesen 15 élő sort,
        // miután a lista 75 oldalasra hízott.)
        if (!sawEnd) {
          console.log(`${tag}   wherewework lapozás: oldal-cap kimerült, a listing csonka lehet → complete=false`);
          foundBySource.get(source).allSucceeded = false;
        }
      }

      // Paginate otp (SAP SuccessFactors): a kereső oldalanként lapoz
      // (?startrow=N), az első válasz CSAK az 1. oldal. E nélkül a 2+. oldal
      // állásai sosem kerülnek a foundUrls-be → a grace után tévesen
      // deaktiválódnak (élőben bizonyítva 2026-07-06: IT-lista 26 állás,
      // "Alkalmazás üzemeltető" a 2. oldalon). Ugyanaz a platform-hiba, mint a
      // kuka 2026-07-01-es fixe. Lapozási hiba → allSucceeded=false, hogy a
      // reconcile ne deaktiváljon részleges lista alapján.
      // 2026-08-21: a lépésköz 25 volt beégetve, a kereső viszont 20-asával lapoz
      // (élő mérés: startrow=0 → 20 találat, startrow=20 → 5, startrow=25 → 0).
      // Emiatt a 25-ös ugrás nemcsak átlépte a 20-24. sorokat, hanem a 0 találatos
      // választ a lista VÉGÉNEK olvasta (sawEnd=true) → a 20. sortól felfelé semmi
      // nem került be, és a foundUrls is csonka maradt. Ezért a lépésköz mostantól
      // az 1. oldalon ténylegesen visszakapott találatszám: a valósnál KISEBB
      // lépésköz csak átfedést okoz (a mergeCandidates dedupel), a NAGYOBB viszont
      // sorokat ugrik át — így ha a forrás megint oldalméretet vált, magától követi.
      if (source === "otp" && merged.length > 0) {
        const stepRows = Math.max(10, merged.length);
        let startrow = stepRows;
        let safetyPagesLeft = 12;
        let sawEnd = false;
        while (safetyPagesLeft-- > 0) {
          const pageUrl = `${p.url}${p.url.includes("?") ? "&" : "?"}startrow=${startrow}`;
          let pageHtml;
          try {
            pageHtml = await fetchText(pageUrl);
          } catch (err) {
            console.log(`${tag}   otp lapozás HIBA (startrow=${startrow}): ${err.message}`);
            await logFetchError("cron_jobs_DIAK_3", { url: pageUrl, message: err.message });
            foundBySource.get(source).allSucceeded = false;
            sawEnd = true; // a hibát már jelöltük, a cap-guard ne írja felül a logot
            break;
          }
          const pgGeneric = extractCandidates(pageHtml, pageUrl).filter((c) => looksLikeJobUrl(source, c.url));
          const pgSsr = extractSSR(pageHtml, pageUrl).filter((c) => looksLikeJobUrl(source, c.url));
          const prevCount = merged.length;
          merged = mergeCandidates(merged, pgGeneric, pgSsr);
          console.log(`${tag}   otp startrow=${startrow}: +${merged.length - prevCount} új (összesen: ${merged.length})`);
          if (merged.length === prevCount) { sawEnd = true; break; } // nincs új találat → utolsó oldal után járunk
          startrow += stepRows;
          await sleep(300);
        }
        // Cap úgy merült ki, hogy az utolsó oldal még adott újat → a listing
        // vége hiányozhat; részleges lista alapján a reconcile nem deaktiválhat.
        if (!sawEnd) {
          console.log(`${tag}   otp lapozás: oldal-cap kimerült, a listing csonka lehet → complete=false`);
          foundBySource.get(source).allSucceeded = false;
        }
      }

      // BUCKET-ONLY forrás (otp teljes-listing nézetek): minden itt látott url a
      // reconcile foundUrls-ébe megy — nincs szűrés, nincs upsert. Rendeltetése,
      // hogy a kategória-listákon KÍVÜL élő, korábban ingestelt sorok ne
      // deaktiválódjanak, és a tévesen off sorokat a reconcile reaktiválja.
      if (p.bucketOnly) {
        const entry = foundBySource.get(source);
        let bucketCount = 0;
        for (const c of merged) {
          if (BLACKLIST_URLS.includes(c.url)) continue;
          entry.urls.push(c.url);
          bucketCount++;
        }
        console.log(`${tag}   bucket-only: ${bucketCount} url a reconcile-bucketbe (upsert nélkül) – ${p.label}`);
        stats.portals.push({ source, label: p.label, url: p.url, ok: true, matched: bucketCount });
        continue;
      }

      if (source === "miszisz") {
        console.log(`${tag}   miszisz: ${merged.length} oldal title-t tölt be...`);
        for (const item of merged) {
          const oldTitle = item.title;
          item.title = await fetchMisziszTitle(item.url, item.title);
          console.log(`${tag}     miszisz title: "${oldTitle}" → "${item.title}"`);
          await sleep(250);
        }
      }

      // =========================
      // FILTER & KEYWORD MATCH
      // =========================
      const _beforeSeniorFilter = merged.length;
      let matchedList = merged
        .map((c) => {
          if (source === "miszisz") c.title = cleanMisziszListTitle(c.title);
          if (source === "wherewework") c.title = cleanWhereweworkTitle(c.title);
          return c;
        })
        .filter((c) => {
          const filtered = isSeniorLike(c.title, c.description);
          if (filtered) console.log(`${tag}   [seniorFilter] KISZŰRVE: "${c.title}"`);
          return !filtered;
        });
      console.log(`${tag}   seniorFilter: ${_beforeSeniorFilter} → ${matchedList.length} (kiszűrve: ${_beforeSeniorFilter - matchedList.length})`);

      if (source === "vizmuvek") {
        const _beforeViz = matchedList.length;
        matchedList = matchedList.filter(c => normalizeText(c.title).includes("gyakornok"));
        console.log(`${tag}   vizmuvek 'gyakornok' szűrő: ${_beforeViz} → ${matchedList.length}`);
      }

      // =========================
      // BLACKLISTING (listák module-szinten — a bucket-ág is használja)
      // =========================
      if (BLACKLIST_SOURCES.some(src => source.startsWith(src))) {
        const _beforeBL = matchedList.length;
        matchedList = matchedList.filter(c => {
          if (BLACKLIST_URLS.includes(c.url)) {
            console.log(`${tag}   [blacklist] KISZŰRVE: "${c.title}" – ${c.url}`);
            return false;
          }
          return true;
        });
        if (_beforeBL !== matchedList.length)
          console.log(`${tag}   blacklist: ${_beforeBL} → ${matchedList.length} (kiszűrve: ${_beforeBL - matchedList.length})`);
      }

      console.log(`${tag}   VÉGEREDMÉNY: ${matchedList.length} állás – ${p.label}`);
      matchedList.forEach((c, i) => console.log(`${tag}     [${i + 1}] "${c.title}" → ${c.url}`));

      stats.portals.push({ source, label: p.label, url: p.url, ok: true, matched: matchedList.length });

      // =========================
      // DB UPSERT
      // =========================
      if (write && client) {
        console.log(`${tag}   DB upsert: ${matchedList.length} állás mentése...`);
        const DIAKMUNKA_SOURCES = ["vizmuvek", "miszisz", "onejob"];
        // Full current listing (pre-filter) of THIS list-url + minden eddig
        // látott url a forrás korábbi entry-jeiből (az otp bucket-nézetek elöl
        // állnak a SOURCES-ban, így a teljes élő listing védve van) — a url in
        // this set is live on the source, so migrateVolatileUrl must never
        // rename its row away.
        const currentUrls = [...new Set([...merged.map((c) => c.url), ...foundBySource.get(source).urls])];
        const patternFor = VOLATILE_URL_PATTERNS[source];
        // wherewework/otp: a detail-fetch (elvárt évek kiolvasása) csak ÚJ url-nél fut.
        // Meglévő sornál kidobott munka: az ON CONFLICT sosem írja felül az
        // experience-t, a lista újra-fetchelése percekig tartana.
        const knownUrls = (source === "wherewework" || source === "otp")
          ? new Set((await client.query(`SELECT url FROM job_posts WHERE source = $1`, [source])).rows.map((r) => r.url))
          : null;
        for (const item of matchedList) {
          const pattern = patternFor ? patternFor(item.url) : null;
          if (pattern) {
            const migrated = await migrateVolatileUrl(client, source, item.url, pattern, currentUrls);
            if (migrated) console.log(`${tag}   MIGRATED url → ${item.url}`);
          }
          if (source === "otp") {
            // OTP itt már nem csak diákmunkát ad vissza: az IT / üzletfejlesztés
            // kategóriák minden szintet tartalmaznak. Ezért — ahogy a professionnél —
            // a névből döntünk, és ha a név nem árulkodik, letöltjük a hirdetést:
            //   • junior/medior a névben → junior/medior
            //   • gyakornoki keyword a névben → diákmunka
            //   • egyébként fetch + hány évet várnak el (extractBodyExperience)
            if (isJuniorTitle(item.title)) {
              item.experience = "junior";
            } else if (isMidLevelTitle(item.title)) {
              item.experience = "medior";
            } else if (isInternshipTitle(item.title)) {
              item.experience = "diákmunka";
            } else {
              const { experience: exp, technologies } = await fetchDetailExperience(item.url);
              item.experience = exp || "-";
              item.technologies = technologies;
              await sleep(400);
            }
          } else if (DIAKMUNKA_SOURCES.includes(source) || isInternshipTitle(item.title)) {
            item.experience = "diákmunka";
          } else if (source === "wherewework" && !knownUrls.has(item.url)) {
            const { experience: exp, technologies } = await fetchDetailExperience(item.url);
            if (exp) item.experience = exp;
            item.technologies = technologies;
            await sleep(400);
          }
          // A cím-alapú gyorsítóágak (otp junior/medior/gyakornok, wherewework
          // gyakornok) fent nem fetchelnek body-t → technologies fetch nélkül
          // maradna. ÚJ posztingnál pótoljuk egyszer, beszúrás ELŐTT (nem
          // update-del utólag) — meglévő sornál a fetch kárba veszne, mert az
          // upsert ON CONFLICT-je úgysem írná felül.
          if (item.technologies === undefined && (source === "otp" || source === "wherewework") && !knownUrls.has(item.url)) {
            const { technologies } = await fetchDetailExperience(item.url);
            item.technologies = technologies;
            await sleep(400);
          }
          if (isSeniorExperience(item.experience)) {
            console.log(`${tag}     SKIP senior [${item.experience}] "${item.title}"`);
            continue;
          }
          console.log(`${tag}     upsert: [${item.experience ?? '-'}] "${item.title}"`);
          await upsertJob(client, source, item);
        }
        console.log(`${tag}   DB upsert kész – ${p.label}`);
        // accumulate urls — reconcile happens once per source key after the whole loop
        const entry = foundBySource.get(source);
        for (const c of matchedList) entry.urls.push(c.url);
      } else if (!write) {
        console.log(`${tag}   (write=false – DB upsert kihagyva)`);
      }
    }

    // reconcile once per source key — prevents multiple OTP (or any repeated-key) URLs
    // from overwriting each other's reconcile results within the same batch
    if (write && client) {
      for (const [src, { urls, allSucceeded }] of foundBySource) {
        const rc = await reconcileActive(client, src, urls, { complete: allSucceeded });
        console.log(`[cron_jobs_DIAK_3] active reconcile [${src}] complete=${allSucceeded} — ${JSON.stringify(rc)}`);
      }
    }
  } finally {
    if (client) client.release();
  }

  return stats;
}


const _runJob = withTimeout("cron_jobs_DIAK_3-background", async (request) => {
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



