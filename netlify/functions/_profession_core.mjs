import https from "node:https";
import http from "node:http";
import zlib from "node:zlib";
import { load as cheerioLoad } from "cheerio";
import pkg from "pg";
const { Pool } = pkg;
import { loadFilters } from "./load_filters.mjs";
import { reconcileActive, migrateVolatileUrl, escapeRegex, loadSameSourceDupeIndex, findSameSourceDuplicate } from "./_active_core.mjs";
import { dupeKey } from "../../src/lib/crossSourceDupe.mjs";
import { INTERNSHIP_KEYWORDS, INTERN_SOURCES, isInternshipTitle, isJuniorTitle, isMidLevelTitle, extractProfessionExperience, extractTechnologies, isSeniorExperience } from "./_experience_core.mjs";
import { isBlockedCompany } from "./_company_blocklist.mjs";
import { shouldSkipTitleFilter, shouldSkipSeniorExperience, seniorAwareExperience } from "./_seniority_policy.mjs";
import { computeLevel } from "../../src/lib/experienceLevel.mjs";

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

// Profession occasionally serves duplicate job URLs with an extra city
// slug just before the numeric job id (e.g. "-budapest-2895930",
// "-debrecen-2953010" / "-pecs-2953010" — same id, same posting, confirmed
// live: both return the identical page, the slug text is ignored
// server-side, see isBudapestLocation's comment above). A curated city list
// (not "any trailing word") on purpose: stripping an arbitrary last word
// would also eat legit company-suffix words like "-kft-"/"-zrt-", changing
// the stored url for the vast majority of UNaffected rows and breaking their
// ON CONFLICT (source, url) match against already-inserted rows.
const DUPLICATE_CITY_SLUGS = [
  "budapest", "debrecen", "szeged", "pecs", "gyor", "miskolc",
  "kecskemet", "szekesfehervar", "nyiregyhaza", "szombathely",
  "veszprem", "eger", "sopron",
];
const CITY_SLUG_RE = new RegExp(
  `-(?:${DUPLICATE_CITY_SLUGS.join("|")})-(\\d+)(\\/pro)?\\/?$`,
  "i"
);

function normalizeUrl(raw) {
  try {
    const u = new URL(raw);

    // Normalize duplicate city-slug URLs to a single canonical path so
    // dedupe/upsert works — see DUPLICATE_CITY_SLUGS above.
    if (/^www\.profession\.hu$/i.test(u.hostname) && /^\/allas\//i.test(u.pathname)) {
      u.pathname = u.pathname.replace(CITY_SLUG_RE, "-$1$2");
    }

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
// Keywords (INTERNSHIP_KEYWORDS / INTERN_SOURCES / isInternshipTitle imported from _experience_core.mjs)
// =====================

function _blacklistRegex(k) {
  const escaped = normalizeText(k).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i");
}

function isSeniorLike(title = "", desc = "") {
  return shouldSkipTitleFilter(title, _filters);
}

// =====================
// HELYSZÍN — csak Budapest
// =====================
// A /budapest/ kereső NEM szűr helyszínre: Szeged, Debrecen, Győr (sőt német városok)
// hirdetései is bejönnek a találati listába.
//
// KÉT CSAPDA a helyszín kiolvasásában:
//  1. A URL városnév-slugja HASZNÁLHATATLAN: bármilyen slug 200-at ad ugyanarra az
//     id-ra (a "…-kft-budapest-2947222" is a szegedi hirdetést adja vissza), és van
//     szegedi hirdetés "-debrecen-" sluggal is.
//  2. A lista-kártya helyszín-mezője CSAK AZ ELSŐDLEGES várost mutatja. Egy
//     "7027 Paks, Budapest, Szeged" hirdetés a kártyán simán "Paks" — ha csak a
//     kártyára hagyatkoznánk, valódi budapesti állásokat dobnánk el.
// Ezért: ha a kártya nem budapesti, a detail-oldal TELJES helyszín-listája dönt
// (.address-data + itemprop=addressLocality) — lásd extractDetailLocation() + a szűrést
// a processOneSource-ban.
//
// FAIL-OPEN: csak akkor dobunk el egy hirdetést, ha a helyszín KIFEJEZETTEN megnevez
// egy nem-budapesti települést ÉS Budapest sehol nem szerepel. Üres, ismeretlen,
// "Távmunka / Remote" helyszín vagy sikertelen detail-fetch → MARAD.
// Ezek NEM települések, csak munkavégzés-módok — a helyszín-vizsgálat előtt kivonjuk őket,
// és ha nem marad valódi városnév, a hirdetés MARAD (lásd a FAIL-OPEN elvet fentebb).
// Az "iroda"/"opcionalis" 2026-07-14-én került be: a "Távmunka / Remote • Opcionális iroda"
// helyszínű (tehát TÁVMUNKA) hirdetéseket a szűrő vidékinek hitte — a work-mode szavak
// kivonása után az "opcionalis iroda" maradt, amit városnévnek vett → 6 élő RemRed-hirdetést
// dobott ki tévesen. Városos formát ez nem enged át: a "Debrecen iroda"-ból az "iroda" kivonása
// után is marad a "debrecen".
const WORK_MODE_WORDS = [
  "hibrid", "hybrid", "tavmunka", "remote", "home office", "homeoffice",
  "orszagos", "orszagosan", "magyarorszag", "hungary",
  "opcionalis iroda", "opcionalis", "iroda",
];

function isBudapestLocation(location) {
  const n = normalizeText(location);
  if (!n) return true;
  if (n.includes("budapest") || /\bbuda\b/.test(n)) return true;

  let rest = n;
  for (const w of WORK_MODE_WORDS) rest = rest.split(w).join(" ");
  rest = rest.replace(/[•\/,;()\-–—.]/g, " ").replace(/\s+/g, " ").trim();
  if (!rest) return true; // pl. "Távmunka / Remote", "Hibrid •"

  // Csak kerület-jelölés maradt (pl. "Hibrid • XIII") → budapesti kerület.
  const districtish = (t) => /^[ivxlc]+$/.test(t) || t === "kerulet" || t === "ker";
  if (rest.split(" ").every(districtish)) return true;

  return false; // valódi, nem budapesti település
}

// A detail-oldal TELJES helyszín-listája (a kártyával ellentétben itt minden város
// szerepel): a "Munkavégzés helye" blokk + a schema.org microdata együtt.
function extractDetailLocation(html) {
  const $ = cheerioLoad(html);
  const parts = [];
  $(".address-data").each((_, el) => parts.push(normalizeWhitespace($(el).text())));
  $('[itemprop="addressLocality"]').each((_, el) => parts.push(normalizeWhitespace($(el).text())));
  return parts.filter(Boolean).join(", ");
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

    let company = null;
    const $logo = card.find('img[alt*="karrier"]').first();
    if ($logo.length) {
      const alt = normalizeWhitespace($logo.attr("alt") || "");
      company = alt.replace(/\s*karrier,?\s*\u00e1ll\u00e1s\s*\u00e9s\s*munka\s*$/i, "").trim() || null;
    }
    if (!company) {
      const $emp = card.find('a[href*="/allasok/"][href*=",0,0,0,0,0,0,0,0,0,"]').first();
      if ($emp.length) {
        const slug = ($emp.attr("href") || "").match(/\/allasok\/([^\/]+)\//)?.[1];
        if (slug) company = slug.replace(/-/g, " ").trim();
      }
    }

    // A kártyán belüli helyszín-mező (id="detailed-job-card-{id}-details-location"),
    // pl. "Budapest", "Hibrid • Budapest XI.kerület", "Szeged", "Távmunka / Remote".
    const location =
      normalizeWhitespace(card.find('[id$="-details-location"]').first().text()) || null;

    items.push({
      title: title.slice(0, 300),
      url,
      description: desc ? desc.slice(0, 800) : null,
      company: company ? company.slice(0, 200) : null,
      location,
    });
  });

  return dedupeByUrl(items);
}

async function extractProfessionCandidatesAllPages(source, baseUrl, startPage = 1, maxPages = Infinity) {
  const all = [];
  const seenUrls = new Set();
  let pagesVisited = 0;
  let pagesWithJobs = 0;
  let pageErrors = 0;
  const effectiveMaxPages = Math.min(
    Number.isFinite(maxPages) ? Math.max(1, Number(maxPages)) : 100,
    100
  );

  for (let page = startPage; ; page++) {
    if (page >= startPage + effectiveMaxPages) {
      console.log(`[profession] maxPages limit (${effectiveMaxPages}) reached, stopping at page ${page}`);
      break;
    }
    const pageUrl = professionPageUrl(baseUrl, page);
    let html;
    try {
      html = await fetchText(pageUrl);
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      if (/HTTP 404/.test(msg)) {
        console.log(`[profession] HTTP 404 at page ${page}: ${pageUrl} — stopping pagination`);
        break;
      }
      // A kihagyott oldal állásai hiányoznak a listából — ezt jelezni KELL a
      // reconcile felé (complete=false), különben egy átmeneti hiba egy teljes
      // oldalnyi still-listed állást deaktiválna.
      pageErrors++;
      console.log(`[profession] fetch error at page ${page}: ${msg} — continuing to next page (marked incomplete)`);
      continue;
    }
    pagesVisited++;

    if (isProfessionNoResultsPage(html)) {
      console.log(`[profession] no-results marker at page ${page}: ${pageUrl} — continuing (waiting for 404)`);
      continue;
    }

    const pageItems = extractCandidates(html, pageUrl).filter((c) =>
      looksLikeJobUrl(source, c.url)
    );

    if (!pageItems.length) {
      console.log(`[profession] no job cards at page ${page}: ${pageUrl} — continuing (waiting for 404)`);
      continue;
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
      console.log(`[profession] page ${page}: no new job URLs (all duplicates) — continuing (waiting for 404)`);
    } else {
      pagesWithJobs++;
    }

    await sleep(10);
  }

  return {
    items: dedupeByUrl(all),
    pagesVisited,
    pagesWithJobs,
    pageErrors,
  };
}

// /allas/{title-company-slug}-{id} — profession re-posts expiring ads under a
// NEW numeric id (DB evidence: net-fejleszto-mortoff-…-2875224 → -2899456 →
// -2925021), which used to reset first_seen and pile up duplicate rows. Only
// 4+ digit tails count (real ids are 7 digits); a shorter numeric tail could be
// part of the title. The still-listed guard (currentUrls) protects concurrent
// same-title postings.
function volatileUrlPattern(url) {
  const m = url.match(/^(.*)-\d{4,}$/);
  return m ? `^${escapeRegex(m[1])}-\\d{4,}$` : null;
}

// =====================
// DB upsert
// =====================
async function upsertJob(client, source, item) {
  const canonicalUrl = normalizeUrl(item.url);

  // Check company first — skip if PannonDiák
  if (item.company === 'PannonDiák') {
    return;
  }

  const experience = seniorAwareExperience(item.title, item.experience) || null;
  await client.query(
    `INSERT INTO job_posts
      (source, title, url, experience, company, technologies, level, first_seen)
     VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
     ON CONFLICT (source, url)
      DO NOTHING    `,
    [source, item.title, canonicalUrl, experience, item.company || null, item.technologies || null, computeLevel({ title: item.title, experience, source })]
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

// EGYSZERI TAKARÍTÁS (2026-07-14) — 42 nem-budapesti sor, ami a Budapest-szűrő (fdfa2a0)
// bevezetése ELŐTT került be, és azóta bent ragadt: 37 közülük AKTÍV volt, tehát vidéki/külföldi
// állás látszott az oldalon (36× Debrecen + 1× Dortmund), 5 pedig inaktív-de-élő.
//
// Miért kell EZ IS a lentebbi detail-alapú purge mellé? Mert az csak a listán MÉG szereplő
// jelöltekre fut. A profession reconcile-ja reactivate-only, tehát az "aktív" NEM bizonyítja,
// hogy a hirdetés még a listán van — a listáról lekerült sorokat a scraper soha többé nem
// látja, így magától sosem takarítaná el őket. Az inaktívakat ráadásul a napi sweep
// revive-köre (SWEEP_SOLE_DEACTIVATOR_SOURCES) minden nap vissza akarná kapcsolni, hiszen a
// hirdetés a saját url-jén ÉL — ezért TÖRÖLNI kell őket, nem kikapcsolva hagyni.
//
// Helyszín MINDEGYIKNÉL a detail-oldal TELJES város-listájából ellenőrizve (nem a kártyáról,
// és főleg nem a URL-ből: a "…-szeged-2944697" valójában DEBRECEN — a slug kozmetikai).
// ⚠️ A 6 RemRed-hirdetés SZÁNDÉKOSAN nincs a listán: azok "Távmunka / Remote • Opcionális
// iroda" helyszínűek, tehát TÁVMUNKÁK — a régi WORK_MODE_WORDS hitte őket vidékinek.
//
// A PURGE_CUTOFF teszi egyszerivé: csak a cutoff ELŐTT beszúrt sorokat törli. Ha egy url
// valaha mégis visszakerülne (mert a hirdető átírta budapestire), az új sor first_seen-je a
// cutoff UTÁN lesz → a purge nem nyúl hozzá, tehát nincs örökös törlés-újraszúrás körhinta.
// Idempotens: ha már nincsenek meg, a DELETE 0 sort érint, és a lista utána nyugodtan törölhető.
const PURGE_CUTOFF = "2026-07-15T00:00:00Z";
const NON_BUDAPEST_PURGE_URLS = [
  "https://www.profession.hu/allas/ai-swe-agentic-handover-engineer-t-cloud-public-ref-m-deutsche-telekom-tsi-hungary-kft-2947033",
  "https://www.profession.hu/allas/ai-swe-agentic-handover-engineer-t-cloud-public-ref-m-deutsche-telekom-tsi-hungary-kft-szeged-2947033",
  "https://www.profession.hu/allas/ai-swe-agentic-handover-engineer-t-cloud-public-ref-y-deutsche-telekom-tsi-hungary-kft-2946955",
  "https://www.profession.hu/allas/ai-swe-agentic-handover-engineer-t-cloud-public-ref-y-deutsche-telekom-tsi-hungary-kft-szeged-2946955",
  "https://www.profession.hu/allas/business-analyst-data-analytics-ref-w-deutsche-telekom-tsi-hungary-kft-szeged-2943045",
  "https://www.profession.hu/allas/cloud-architect-for-t-cloud-public-ref-n-deutsche-telekom-tsi-hungary-kft-2947127",
  "https://www.profession.hu/allas/cloud-architect-for-t-cloud-public-ref-n-deutsche-telekom-tsi-hungary-kft-szeged-2947127",
  "https://www.profession.hu/allas/cloud-architect-t-cloud-public-ref-b-deutsche-telekom-tsi-hungary-kft-2947147",
  "https://www.profession.hu/allas/cloud-architect-t-cloud-public-ref-b-deutsche-telekom-tsi-hungary-kft-szeged-2947147",
  "https://www.profession.hu/allas/cloud-devops-engineer-ref-b-deutsche-telekom-tsi-hungary-kft-szeged-2944697",
  "https://www.profession.hu/allas/cloud-engineer-adesso-business-consulting-kft-2947113",
  "https://www.profession.hu/allas/cloud-engineer-t-cloud-public-deutsche-telekom-tsi-hungary-kft-debrecen-2943258",
  "https://www.profession.hu/allas/cloud-engineer-t-cloud-public-deutsche-telekom-tsi-hungary-kft-szeged-2943258",
  "https://www.profession.hu/allas/cloud-engineer-t-cloud-public-ref-e-deutsche-telekom-tsi-hungary-kft-2946800",
  "https://www.profession.hu/allas/cloud-engineer-t-cloud-public-ref-e-deutsche-telekom-tsi-hungary-kft-szeged-2946800",
  "https://www.profession.hu/allas/data-engineer-ref-y-deutsche-telekom-tsi-hungary-kft-szeged-2944621",
  "https://www.profession.hu/allas/devops-engineer-ref-x-deutsche-telekom-tsi-hungary-kft-2947160",
  "https://www.profession.hu/allas/german-speaking-devops-engineer-ref-q-deutsche-telekom-tsi-hungary-kft-szeged-2944536",
  "https://www.profession.hu/allas/integrated-intelligence-analyst-deutsche-telekom-tsi-hungary-kft-2947050",
  "https://www.profession.hu/allas/integrated-intelligence-analyst-deutsche-telekom-tsi-hungary-kft-szeged-2947050",
  "https://www.profession.hu/allas/ki-engineer-ki-anwendungsbetreuer-in-w-m-d-budapesti-nemetnyelvu-tavtanulasi-kozpont-alapitvany-2938506",
  "https://www.profession.hu/allas/kubernetes-security-governance-deutsche-telekom-tsi-hungary-kft-2947222",
  "https://www.profession.hu/allas/kubernetes-security-governance-deutsche-telekom-tsi-hungary-kft-szeged-2947222",
  "https://www.profession.hu/allas/linux-devops-engineer-deutsche-telekom-tsi-hungary-kft-2947145",
  "https://www.profession.hu/allas/linux-devops-engineer-deutsche-telekom-tsi-hungary-kft-szeged-2947145",
  "https://www.profession.hu/allas/microsoft-architect-with-german-language-ref-s-deutsche-telekom-tsi-hungary-kft-2946872",
  "https://www.profession.hu/allas/mobile-network-security-governance-deutsche-telekom-tsi-hungary-kft-2947203",
  "https://www.profession.hu/allas/mobile-network-security-governance-deutsche-telekom-tsi-hungary-kft-szeged-2947203",
  "https://www.profession.hu/allas/quality-engineer-functional-test-and-migration-test-german-speaking-ref-p-deutsche-telekom-tsi-hungary-kft-debrecen-2943063",
  "https://www.profession.hu/allas/quality-engineer-functional-test-and-migration-test-german-speaking-ref-p-deutsche-telekom-tsi-hungary-kft-szeged-2943063",
  "https://www.profession.hu/allas/software-architect-tas-ref-x-deutsche-telekom-tsi-hungary-kft-debrecen-2943279",
  "https://www.profession.hu/allas/software-architect-tas-ref-x-deutsche-telekom-tsi-hungary-kft-szeged-2943279",
  "https://www.profession.hu/allas/solution-engineer-ref-a-deutsche-telekom-tsi-hungary-kft-szeged-2943318",
  "https://www.profession.hu/allas/sovereign-ai-platform-engineer-t-cloud-public-ref-y-deutsche-telekom-tsi-hungary-kft-2946952",
  "https://www.profession.hu/allas/sovereign-ai-platform-engineer-t-cloud-public-ref-y-deutsche-telekom-tsi-hungary-kft-szeged-2946952",
  "https://www.profession.hu/allas/specialist-devops-engineer-t-cloud-public-ref-x-deutsche-telekom-tsi-hungary-kft-szeged-2944626",
  "https://www.profession.hu/allas/technical-business-analyst-with-english-and-german-ref-v-deutsche-telekom-tsi-hungary-kft-2946781",
  "https://www.profession.hu/allas/technical-business-analyst-with-english-and-german-ref-v-deutsche-telekom-tsi-hungary-kft-szeged-2946781",
  "https://www.profession.hu/allas/technology-engineer-ref-k-deutsche-telekom-tsi-hungary-kft-szeged-2944644",
  "https://www.profession.hu/allas/test-automation-engineer-playwright-selenium-cypress-german-speaking-ref-u-deutsche-telekom-tsi-hungary-kft-szeged-2943249",
  "https://www.profession.hu/allas/test-automation-engineer-ref-i-deutsche-telekom-tsi-hungary-kft-szeged-2944589",
  "https://www.profession.hu/allas/ux-ui-designer-ref-u-deutsche-telekom-tsi-hungary-kft-szeged-2944501",
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
    // Normal cron mode — process all sources, accumulate foundUrls per source key,
    // then reconcile ONCE per key at the end so that multiple URLs sharing the same
    // source key (e.g. all P_* tasks using "profession-intern") don't overwrite
    // each other's reconcile results.
    const client = await pool.connect();
    const foundBySource = new Map(); // source -> urls: string[]
    try {
      // Run-eleji takarítás (cég-blocklist mintája): a Budapest-szűrő bevezetése előtt
      // bent ragadt nem-budapesti sorok egyszeri törlése. A first_seen < PURGE_CUTOFF
      // teszi egyszerivé — egy később újra beszúrt sorhoz már nem nyúl (nincs körhinta).
      if (NON_BUDAPEST_PURGE_URLS.length > 0) {
        const { rowCount } = await client.query(
          `DELETE FROM job_posts
            WHERE source LIKE 'profession%'
              AND url = ANY($1::text[])
              AND first_seen < $2::timestamptz`,
          [NON_BUDAPEST_PURGE_URLS, PURGE_CUTOFF]
        );
        if (rowCount > 0) console.log(`[${jobName}] purge: ${rowCount} nem-budapesti sor törölve (egyszeri takarítás)`);
      }

      // Only a genuinely NEW url needs its own detail-page fetch for
      // experience/technologies — an already-known row is already complete
      // and ON CONFLICT DO NOTHING would discard the fetch anyway.
      const sourceKeys = [...new Set(sources.map((s) => s.key))];
      const { rows: knownRows } = await client.query(
        `SELECT source, url FROM job_posts WHERE source = ANY($1::text[])`,
        [sourceKeys]
      );
      const knownBySource = new Map(sourceKeys.map((k) => [k, new Set()]));
      for (const r of knownRows) knownBySource.get(r.source)?.add(r.url);

      // Same-source duplicate guard (2026-09-04, same pattern as LinkedIn):
      // profession.hu re-lists a re-posted ad under a brand-new numeric id
      // (not a rotating id within a stable pattern, so migrateVolatileUrl
      // doesn't catch it) — confirmed live, 5 duplicate clusters. Built once
      // per source key, updated as items get inserted so a duplicate found
      // across two different P_* task URLs in the SAME run is also caught.
      const sameSourceDupeIndexes = new Map();
      for (const key of sourceKeys) {
        sameSourceDupeIndexes.set(key, await loadSameSourceDupeIndex(client, key));
      }

      for (const p of sources) {
        const result = await processOneSource(client, p, jobName, pageOptions, knownBySource, sameSourceDupeIndexes.get(p.key));
        const urls = foundBySource.get(result.source) || [];
        // Found urls still feed reconcile as reactivation signal (presence =
        // alive) even on a partial crawl — see the reactivate-only note below.
        if (result.ok) urls.push(...result.foundUrls);
        foundBySource.set(result.source, urls);
        await sleep(50);
      }
      for (const [source, urls] of foundBySource) {
        // complete:false → reactivate-only, NEVER listing-diff deactivation.
        // Profession's search demotes aged ads out of the paginated category
        // listings well before the ad actually closes (2026-07-12: live rows
        // absent from every page of every category we crawl), so absence here
        // proves nothing. Deactivation is owned by cron_404sweep-background's
        // REDIRECT_DEAD_SOURCES rule (_active_core.mjs) instead, which reads
        // each row's OWN url.
        const rc = await reconcileActive(client, source, urls, { complete: false });
        console.log(`[${jobName}] ${source}: active reconcile (reactivate-only) ${JSON.stringify(rc)}`);
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

async function processOneSource(client, p, jobName, { startPage = 1, maxPages = Infinity } = {}, knownBySource = null, sameSourceDupeIndex = null) {
  const source = p.key;

  let merged = [];
  let complete = true;
  try {
    if (source.startsWith("profession")) {
      const professionResult = await extractProfessionCandidatesAllPages(source, p.url, startPage, maxPages);
      merged = professionResult.items;
      complete = (professionResult.pageErrors || 0) === 0;
      console.log(
        `[profession] crawled ${professionResult.pagesVisited} page(s), ` +
          `${professionResult.pagesWithJobs} page(s) with jobs, ` +
          `${professionResult.pageErrors || 0} page error(s) for source URL: ${p.url}`
      );
    } else {
      const html = await fetchText(p.url);
      merged = extractCandidates(html, p.url).filter((c) => looksLikeJobUrl(source, c.url));
    }
  } catch (err) {
    console.error(`[${jobName}] fetch failed for ${p.url}: ${err.message}`);
    return { source, label: p.label, url: p.url, ok: false, error: err.message, foundUrls: [] };
  }

  let matchedList = merged.filter((c) => !shouldSkipTitleFilter(c.title, _filters));
  matchedList = matchedList.filter((c) => !isBlockedCompany(c.company, source));

  // Csak budapesti állások kellenek. A kiszűrt sorok a foundUrls-ból is kimaradnak,
  // így a reconcile sem élesztheti újra egy korábban bekerült vidéki hirdetés sorát.
  // (currentUrls SZÁNDÉKOSAN a szűretlen listából jön — a vidéki url-ek is élnek a
  // forráson, a migrateVolatileUrl still-listed guardjának látnia kell őket.)
  if (source.startsWith("profession")) {
    const kept = [];
    let dropped = 0;
    for (const c of matchedList) {
      if (isBudapestLocation(c.location)) {
        kept.push(c);
        continue;
      }
      // A kártya csak az elsődleges várost mutatja — mielőtt eldobjuk, a detail-oldal
      // teljes helyszín-listája dönt (pl. kártyán "Paks", valójában "Paks, Budapest,
      // Szeged"). A letöltött HTML-t eltesszük: lejjebb az experience/technologies
      // kinyerésének már nem kell újra lekérnie.
      try {
        await sleep(300);
        c.detailHtml = await fetchText(c.url);
      } catch (err) {
        kept.push(c); // fail-open: ha nem tudjuk ellenőrizni, marad
        continue;
      }
      if (isBudapestLocation(extractDetailLocation(c.detailHtml))) {
        kept.push(c);
        continue;
      }
      dropped++;
      // Csak megelőzés: a sor kimarad a kept/matchedList-ből, tehát sosem kerül
      // (újra)beszúrásra. Egy már korábban bekerült vidéki sort NEM töröl — a
      // scraper nem jogosult DELETE-re a job_posts táblán.
    }
    matchedList = kept;
    if (dropped) console.log(`[${source}] ${dropped} nem-budapesti hirdetés kiszűrve`);
  }

  if (BLACKLIST_SOURCES.some(src => source.startsWith(src))) {
    matchedList = matchedList.filter(c => !BLACKLIST_URLS.includes(c.url));
  }

  if (client) {
    // Full current listing (pre-filter) — a url in this set is live on the
    // source, so migrateVolatileUrl must never rename its row away.
    const currentUrls = merged.map((c) => c.url);
    const known = knownBySource?.get(source);
    for (const item of matchedList) {
      if (isInternshipTitle(item.title)) item.experience = "diákmunka";
      else if (isJuniorTitle(item.title)) item.experience = "junior";
      else if (isMidLevelTitle(item.title)) item.experience = "medior";

      const prefixMatch = item.title.match(/^\s*[Dd]i[áa]kmunka\s*[-–—:]\s*(.+)$/);
      const suffixMatch = item.title.match(/^(.+?)\s*[-–—:]\s*[Dd]i[áa]kmunka\s*$/);
      let stripped = null;
      if (prefixMatch) stripped = prefixMatch[1].replace(/\s+/g, " ").trim();
      else if (suffixMatch) stripped = suffixMatch[1].replace(/\s+/g, " ").trim();

      if (stripped) {
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

      // Fetch the detail page ONCE for a genuinely new posting (that survived
      // the dedupe check above) and fully populate the row before it's ever
      // inserted — no separate pass comes back later to patch it in. This runs
      // even when the title already revealed the experience level: technologies
      // only ever comes from the detail page, so skipping the fetch there used
      // to leave technologies permanently null for every title-shortcut match
      // (junior/medior/diákmunka keyword in the title).
      if (known && !known.has(item.url)) {
        try {
          let detailHtml = item.detailHtml; // a helyszín-ellenőrzés már letölthette
          if (!detailHtml) {
            await sleep(300);
            detailHtml = await fetchText(item.url);
          }
          if (!item.experience) item.experience = extractProfessionExperience(detailHtml) || "-";
          item.technologies = extractTechnologies(detailHtml);
        } catch (err) {
          console.warn(`[profession] detail fetch failed: ${item.url} — ${err.message}`);
        }
      }
      delete item.detailHtml;

      if (shouldSkipSeniorExperience(isSeniorExperience(item.experience))) {
        console.log(`[${source}] SKIP senior-experience [${item.experience}] "${item.title}" → ${item.url}`);
        continue;
      }

      const pattern = volatileUrlPattern(item.url);
      if (pattern) {
        const migrated = await migrateVolatileUrl(client, source, item.url, pattern, currentUrls);
        if (migrated) console.log(`[${source}] MIGRATED url → ${item.url}`);
      }

      if (sameSourceDupeIndex) {
        const dupe = findSameSourceDuplicate(sameSourceDupeIndex, item.url, item.company, item.title, item.technologies);
        if (dupe) {
          console.log(`[${source}] SKIP same-source dupe "${item.title}" @ ${item.company || "-"} — already active at ${dupe.url}`);
          continue;
        }
      }

      await upsertJob(client, source, item);

      if (sameSourceDupeIndex) {
        const key = dupeKey(item.company, item.title);
        if (key) {
          if (!sameSourceDupeIndex.has(key)) sameSourceDupeIndex.set(key, []);
          sameSourceDupeIndex.get(key).push({ url: item.url, technologies: item.technologies });
        }
      }
    }

  }

  const foundUrls = matchedList.map((c) => c.url);
  console.log(`[${jobName}] ${source}: ${matchedList.length} items processed for ${p.url}`);
  return { source, label: p.label, url: p.url, ok: true, matched: matchedList.length, foundUrls, complete };
}
