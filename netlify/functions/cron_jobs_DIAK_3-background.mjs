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
import { reconcileActive } from "./_active_core.mjs";
import { extractBodyExperience, INTERNSHIP_KEYWORDS, isInternshipTitle, isJuniorTitle, isMidLevelTitle } from "./_experience_core.mjs";

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

  { key: "otp", label: "OTP", url: "https://karrier.otpbank.hu/search/?searchby=location&createNewAlert=false&q=di%C3%A1kmunka&locationsearch=Budapest&geolocation=&optionsFacetsDD_city=&optionsFacetsDD_customfield1=&optionsFacetsDD_customfield2=&optionsFacetsDD_title=" },
    { key: "otp", label: "OTP", url: "https://karrier.otpbank.hu/search/?searchby=location&createNewAlert=false&q=&locationsearch=Budapest&geolocation=&optionsFacetsDD_city=Budapest&optionsFacetsDD_customfield1=&optionsFacetsDD_customfield2=Üzletfejlesztés+és+innováció&optionsFacetsDD_title=&_gl=1*eqovvy*_up*MQ..*_ga*NDIyODM3NjU3LjE3ODAzMjUzMDY.*_ga_MS48V6C7P1*czE3ODAzMjUzMDYkbzEkZzEkdDE3ODAzMjU0MTgkajE0JGwwJGgw"},
  { key: "otp", label: "OTP", url: "https://karrier.otpbank.hu/search/?searchby=location&createNewAlert=false&q=&locationsearch=Budapest&geolocation=&optionsFacetsDD_city=Budapest&optionsFacetsDD_customfield1=&optionsFacetsDD_customfield2=Informatika+és+digitalizáció&optionsFacetsDD_title=&_gl=1*1xvjrq1*_up*MQ..*_ga*MTA2NjU1MTQ3NS4xNzc5ODA3OTk5*_ga_MS48V6C7P1*czE3Nzk4MDc5OTkkbzEkZzAkdDE3Nzk4MDc5OTkkajYwJGwwJGgw" },
  { key: "vizmuvek",  label:  "vizmuvek", url: "https://www.vizmuvek.hu/hu/karrier/gyakornoki-dualis-kepzes" },
  { key: "wherewework", label: "wherewework", url: "https://www.wherewework.hu/en/jobs/budaors,budapest/bpo-services,health-services,other-services,others,pharmaceutical,horeca,itc,trade,agriculture,education" },
  { key: "wherewework", label: "wherewework", url: "https://www.wherewework.hu/en/jobs/student-internship,entry-level-2-years/budapest?page=1" },
  { key: "onejob", label: "onejob", url: "https://onejob.hu/munkaink/?job__category_spec=informatika&job__location_spec=budapest" },
  { key: "miszisz", label: "MISZISZ", url: "https://miszisz.hu/?post_type%5B%5D=munkaink&s=&mmin=0&mmax=8000&mvaros%5B%5D=0&mvaros%5B%5D=2&mvaros%5B%5D=3&mvaros%5B%5D=4&mvaros%5B%5D=6&mvaros%5B%5D=7&mvaros%5B%5D=8&mvaros%5B%5D=9&mvaros%5B%5D=10&mvaros%5B%5D=11&mvaros%5B%5D=12&mvaros%5B%5D=15&mvaros%5B%5D=17&mvaros%5B%5D=21&mvaros%5B%5D=68&mvaros%5B%5D=69&mvaros%5B%5D=368&mkat%5B%5D=231&mkat%5B%5D=40&mkat%5B%5D=257&mkat%5B%5D=41" },
  // nofluffjobs → áttéve: cron_jobs_NOFLUFFJOBS-background.mjs
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
  await client.query(
    `INSERT INTO job_posts
      (source, title, url, experience, company, first_seen)
     VALUES ($1,$2,$3,$4,$5,NOW())
     ON CONFLICT (source, url)
        DO NOTHING;`,
    [source, item.title, item.url, item.experience ?? "-", item.company || null]
  );
}


async function fetchNofluffExperience(url) {
  try {
    const html = await fetchText(url);
    const normalizedHtml = html.replace(/\u2013/g, "-").replace(/\u2014/g, "-");
    return extractBodyExperience(normalizedHtml) || null;
  } catch (err) {
    await logFetchError("cron_jobs_DIAK_3", { url, message: `nofluff experience: ${err.message}` });
    return null;
  }
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

      // Paginate wherewework (follows [rel="next"] links until exhausted; 15-page cap against infinite loops)
      if (source === "wherewework") {
        let pageHtml = html;
        let pageUrl = p.url;
        let safetyPagesLeft = 25;
        let pageNum = 1;
        while (safetyPagesLeft-- > 0) {
          const $pg = cheerioLoad(pageHtml);
          const nextHref = $pg('[rel="next"]').attr("href");
          if (!nextHref) { console.log(`${tag}   wherewework: nincs több oldal (${pageNum} oldal után)`); break; }
          const nextUrl = absolutize(nextHref, pageUrl);
          if (!nextUrl) break;
          pageNum++;
          console.log(`${tag}   wherewework: oldal ${pageNum} → ${nextUrl}`);
          try {
            pageHtml = await fetchText(nextUrl);
          } catch (err) {
            console.log(`${tag}   wherewework oldal ${pageNum} HIBA: ${err.message}`);
            await logFetchError("cron_jobs_DIAK_3", { url: nextUrl, message: err.message });
            break;
          }
          if (pageHtml.includes("We are sorry you didn't find the job you were looking for!")) {
            console.log(`${tag}   wherewework: "no jobs" oldal – megáll`);
            break;
          }
          const pgGeneric = extractCandidates(pageHtml, nextUrl).filter((c) => looksLikeJobUrl(source, c.url));
          const pgSsr = extractSSR(pageHtml, nextUrl).filter((c) => looksLikeJobUrl(source, c.url));
          const prevCount = merged.length;
          merged = mergeCandidates(merged, pgGeneric, pgSsr);
          console.log(`${tag}   wherewework oldal ${pageNum}: +${merged.length - prevCount} új (összesen: ${merged.length})`);
          pageUrl = nextUrl;
          await sleep(300);
        }
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
      // BLACKLISTING
      // =========================
      const BLACKLIST_SOURCES = [ "jobline", "otp","muisz"];
      const BLACKLIST_URLS = [
        "https://jobline.hu/allasok/25,200307,162",
        "https://karrier.otpbank.hu/go/Minden-allasajanlat/1167001/?q=",
        "https://muisz.hu/hu/regisztracio",
        "https://muisz.hu/hu/diakmunkaink",
        "https://karrier.otpbank.hu/otp/job/Budapest-Gyakornok-V%C3%A1llalati-Sz%C3%A1mlavezet%C3%A9si-K%C3%B6zpont-1051-Budapest-N%C3%A1dor-utca-6_-1051/1366316233/",

      ];

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
        for (const item of matchedList) {
          if (source === "otp") {
            // OTP-nál valódi junior/medior IT/üzleti állások is vannak, ezért NEM
            // címkézünk mindent diákmunkának: a tiszta junior/medior címeket
            // előléptetjük, minden más marad diákmunka.
            item.experience = isJuniorTitle(item.title) ? "junior"
              : isMidLevelTitle(item.title) ? "medior"
              : "diákmunka";
          } else if (DIAKMUNKA_SOURCES.includes(source) || isInternshipTitle(item.title)) {
            item.experience = "diákmunka";
          } else if (source === "wherewework") {
            const exp = await fetchNofluffExperience(item.url);
            if (exp) item.experience = exp;
            await sleep(400);
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



