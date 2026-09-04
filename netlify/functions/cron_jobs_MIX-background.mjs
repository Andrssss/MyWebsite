/* =========================
  "https://api.dreamjobs.hu/api/v1/hu/jobs?region=hu&page=1&per_page=100",
  "https://melonjobs.hu/wp-json/wp/v2/job-listings?per_page=100&page=1";
  "https://jobs.kuka.com/tile-search-results/?q=&locationsearch=HU&optionsFacetsDD_department=IT";
*/


import { Pool } from "pg";
import https from "https";
import http from "http";
import zlib from "zlib";
import { load as cheerioLoad } from "cheerio";
import { loadFilters } from "./load_filters.mjs";
import { withTimeout } from "./_error-logger.mjs";
import { reconcileActive, migrateVolatileUrl, escapeRegex, loadSameSourceDupeIndex, findSameSourceDuplicate } from "./_active_core.mjs";
import { loadCrossSourceDupeIndex, isCrossSourceDupe, CROSS_SOURCE_DUPE_SOURCES } from "./_cross_source_dupe.mjs";
import { dupeKey } from "../../src/lib/crossSourceDupe.mjs";
import {
  extractBodyExperience,
  extractKukaExperience,
  extractTechnologies,
  INTERNSHIP_KEYWORDS,
  isSeniorExperience,
} from "./_experience_core.mjs";
import { shouldSkipTitleFilter, shouldSkipSeniorExperience, isSeniorTitleFilterMatch, seniorAwareExperience } from "./_seniority_policy.mjs";

let _filters = [];

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

const MAX_PAGES = 20;

// 2026-07-01: the API moved the locale into the path — `/api/v1/jobs` now 404s,
// the live endpoint is `/api/v1/{locale}/jobs`. Same query filters still work.
// (The job shape also renamed `slugs` → `slug` as a {en,hu,ro} map, but
// buildDreamJobsUrl already falls back to `job.slug`, so no change needed there.)
//
// 2026-07-21: dropped the `tags[office-location]` filter (was 2925=Budapest,
// 15990=Távmunka only). A full unfiltered live scan showed 2/20 correctly-categorized
// IT postings sitting outside those two tags (Pécs, Veszprém) — invisible to the
// scraper purely because of the location tag, not a category problem.
//
// 2026-08-20: MEGSZŰNT a szerver-oldali `tags[job-category][]` szűrő is, a melonjobs
// mintájára (lásd ott a részletes indoklást). A site összesen 59 élő állást tart
// (`pagination.total`, egyetlen oldal), és MINDEN állás magával hozza a saját
// `tags.job_category` objektumát {id, slug, name} — nem kell külön taxonómia-lehívás,
// a kategória-szűrés így ingyen elvégezhető itthon. Amit ez megold:
//  1. a reconcile bucket a TELJES élő lista lehet (kategória/senior szűrés előtt);
//  2. egy ÚJ kategória nem tűnik el némán — a lenti "el nem bírált kategória" warn szól;
//  3. a `scope[]=isNotBlue` is kliens-oldalra került (`job.is_blue`) — élőben amúgy
//     jelenleg no-op: 59 találat vele is, nélküle is.
const DREAMJOBS_API_URLS = [
  "https://api.dreamjobs.hu/api/v1/hu/jobs?region=hu&page=1&per_page=100",
];

// IT-kategóriák. A 44/58/22381 a site MAI taxonómiájában már NEM létezik (2026-08-20:
// a dreamjobs.hu saját searchbar-szűrője 16 kategóriát kínál, és mind a 16 megjelenik
// az 59 élő állás között — ez a három nincs köztük). Szándékosan BENNMARADNAK: nulla
// költségű kliens-oldali id-check, a törlésük viszont pont az a hiba lenne, amit a
// melonjobs kat.63-nál javítottunk.
// 55 engineer-1 ("Mérnök") általános mérnöki kategória — jelenleg nem IT tartalommal
// (PLC-automatizálás, MEO-referens), de RÉGÓTA a listában van, így nem nyúlok hozzá:
// az "üresnek/rossznak látszik → kivágom" reflex a bug forrása, nem a megoldása.
const DREAMJOBS_IT_CATEGORY_IDS = new Set([57, 49, 55, 44, 58, 22381]);
const DREAMJOBS_IT_CATEGORY_SLUGS = new Set(["it-development", "it-operations-pm", "engineer-1"]);

// Már ELBÍRÁLT, tudatosan kihagyott kategóriák (2026-08-20-i élő taxonómia).
// Ami se itt, se a fenti IT-listákban nincs benne, az ÚJ → warn megy a logba, hogy
// eldöntsük. Ez pontosabb jelzés, mint egy kulcsszó-heurisztika a slugon.
const DREAMJOBS_NON_IT_CATEGORY_IDS = new Set([
  45,    // finance-4 — Pénzügy
  50,    // law-1 — Jog/Compliance
  51,    // executive-management — Cégvezetés, Menedzsment
  52,    // marketing-pr-design — Marketing, PR, Design
  53,    // administration-6 — Irodai munka
  56,    // sales-customer-support — Sales
  59,    // others — Egyéb
  3971,  // hr-recruitment-employer-branding — HR
  20985, // logistics-purchasing — Logisztika, Beszerzés
  21025, // education-research — Oktatás
  76376, // hospitality-tourism — Vendéglátás és Turizmus
  80399, // skilled-manual-labor — Szakmunka & Fizikai munka
  80400, // engineering-manufacturing — Mérnök & Gyártás (élőben: operátor/termelés, nem IT)
]);

// 2026-08-20: MEGSZŰNT az API-oldali `job-categories=` szűrő.
// Előzmény: 2026-07-14-én a 63-as kategóriát azért vettük ki a listából, mert
// "ÜRES kategóriának" látszott (aznap 0 találat) — közben a 63 = "Programozó,
// Fejlesztő", a site LEGFONTOSABB IT-kategóriája, csak épp nem volt benne
// aktív hirdetés. Emiatt 2026-08-20-ig nem került be pl. a "Backend fejlesztő
// (JAVA, Springboot)" (Trans-Uni Kft., Budapest). Tanulság: egy kategória
// PILLANATNYI darabszáma nem bizonyíték arra, hogy nem kell figyelni.
//
// A site összesen ~65 élő hirdetést tart (egyetlen 100-as oldal), így a teljes
// listát lekérni ingyen van, és a kategóriát itthon szűrjük. Ez két dolgot old meg:
//  1. a reconcile bucket a TELJES élő lista lehet (lásd fetchAllMelonJobs) —
//     egy még kint lévő hirdetés soha nem deaktiválódik csak azért, mert a
//     kategória/helyszín/senior szűrőnk kiejtette;
//  2. új IT-kategória automatikusan bejön a slug-alapú illesztésen keresztül.
const MELONJOBS_LISTINGS_URL =
  "https://melonjobs.hu/wp-json/wp/v2/job-listings?per_page=100&page=1&_fields=id,link,title,content,meta,job-categories";
const MELONJOBS_TAXONOMY_URL =
  "https://melonjobs.hu/wp-json/wp/v2/job-categories?per_page=100&page=1&_fields=id,name,slug";

// A term-ID WordPressben állandó, a slug viszont szerkeszthető — ezért a kettő
// UNIÓJA dönt: az id-lista a már ismert kategóriákat rögzíti (átnevezés ellen),
// a slug-lista pedig az újonnan felvett/átszámozott termeket kapja el.
// Szándékosan KIMARADT: 125 informatikai-ertekesito (értékesítés, nem IT-szerep),
// 74 it-fejlesztesi-vezeto (vezetői pozíció, nem pályakezdő-profil),
// 54 adatrogzito (adatrögzítés — a job_filters is tiltja).
const MELONJOBS_IT_CATEGORY_IDS = new Set([31, 55, 60, 62, 63, 110, 112, 148, 163, 178, 199, 237]);
const MELONJOBS_IT_SLUGS = new Set([
  "it-informatika",
  "adatbazisszakerto",
  "it-support-helpdesk",
  "rendszergazda",
  "programozo-fejleszto",
  "tesztelo-tesztmernok",
  "it-tanacsado-elemzo-auditor",
  "vallalatiranyitasi-rendszer-sap",
  "rendszertervezo",
  "informaciobiztonsag",
  "rendszeruzemelteto-karbantarto",
  "rendszerintegrator",
]);

// Csak naplózásra: ha egy ÉLŐ hirdetés olyan kategóriában ül, aminek IT-szagú a
// slugja, de egyik listánkban sincs benne, azt kiírjuk — így a következő bővítés
// nem attól függ, hogy valaki véletlenül észreveszi. Nem szűr, nem ingesztál.
const MELONJOBS_IT_HINT =
  /(^|-)(it|informatik|szoftver|software|fejleszto|programozo|rendszer|tesztel|devops|adatbazis|halozat|cyber|web)/;

const KUKA_API_URL =
  "https://jobs.kuka.com/tile-search-results/?q=&locationsearch=HU";


/* ── shared helpers ─────────────────────────────────────────── */

function normalizeWhitespace(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeUrl(raw) {
  try {
    const url = new URL(raw);
    url.hash = "";
    ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid"].forEach((key) =>
      url.searchParams.delete(key)
    );
    return url.toString().replace(/\?$/, "");
  } catch {
    return raw;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fetchText(url, redirectLeft = 5) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const lib = parsedUrl.protocol === "https:" ? https : http;

    const req = lib.request(
      parsedUrl,
      {
        method: "GET",
        headers: {
          "User-Agent": "JobWatcher/1.0",
          Accept: "application/json,text/plain;q=0.9,*/*;q=0.8",
          "Accept-Language": "hu-HU,hu;q=0.9,en;q=0.8",
          "Accept-Encoding": "gzip,deflate,br",
        },
        timeout: 25000,
      },
      (res) => {
        const code = res.statusCode || 0;

        if ([301, 302, 303, 307, 308].includes(code)) {
          const location = res.headers.location;
          if (!location) return reject(new Error(`HTTP ${code} (no Location) for ${url}`));
          if (redirectLeft <= 0) return reject(new Error(`Too many redirects for ${url}`));
          const nextUrl = new URL(location, url).toString();
          res.resume();
          return resolve(fetchText(nextUrl, redirectLeft - 1));
        }

        const encoding = String(res.headers["content-encoding"] || "").toLowerCase();
        let stream = res;

        if (encoding.includes("gzip")) stream = res.pipe(zlib.createGunzip());
        else if (encoding.includes("deflate")) stream = res.pipe(zlib.createInflate());
        else if (encoding.includes("br")) stream = res.pipe(zlib.createBrotliDecompress());

        let body = "";
        stream.setEncoding("utf8");
        stream.on("data", (chunk) => {
          body += chunk;
        });
        stream.on("end", () => {
          if (code >= 200 && code < 300) resolve(body);
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

async function fetchJson(url) {
  const text = await fetchText(url);
  return JSON.parse(text);
}

function htmlToText(html) {
  const $ = cheerioLoad(`<div>${html ?? ""}</div>`);
  return normalizeWhitespace($.text());
}

async function upsertJob(client, sourceKey, item) {
  // Insert-only, kivétel nélkül (user-szabály, LinkedInen kívül sehol nincs
  // utólagos UPDATE): a sor insert előtt épül fel teljesen, a konfliktus
  // esetén a meglévő sor változatlan marad.
  await client.query(
    `INSERT INTO job_posts
      (source, title, url, experience, company, technologies, first_seen)
     VALUES ($1,$2,$3,$4,$5,$6,NOW())
     ON CONFLICT (source, url) DO NOTHING;`,
    [sourceKey, item.title, item.url, seniorAwareExperience(item.title, item.experience) ?? "-", item.company || null, item.technologies ?? null]
  );
}

// Only a genuinely NEW url needs its own detail-page fetch for experience —
// an already-known row is already complete, so the upsert would at most
// backfill its company (never experience/technologies). Builds the row
// COMPLETE before it's ever inserted; no separate pass comes back later to
// patch it in.
async function enrichIfNew(job, known, extract, jobName) {
  // technologies KIZÁRÓLAG innen jön, ezért a fetch minden új url-nél lefut —
  // még akkor is, ha a job.experience-t már a tag/cím-alapú rövidzár feloldotta.
  if (known.has(job.url)) return;
  try {
    await sleep(400);
    const html = await fetchText(job.url);
    if (!job.experience || job.experience === "-") job.experience = extract(html) || "-";
    job.technologies = extractTechnologies(html);
  } catch (err) {
    console.warn(`[${jobName}] detail fetch failed: ${job.url} — ${err.message}`);
  }
}

/* ── DreamJobs ──────────────────────────────────────────────── */

// DreamJobs slugs come in several shapes: a plain string, a per-language map
// like { en, hu, ro }, or (buggy API) a JSON-blob string of that map. Resolve to
// one clean slug and NEVER let anything JSON-ish / whitespace into a URL.
function resolveDreamSlug(raw, lang) {
  if (raw == null) return "";
  if (typeof raw === "object") {
    return normalizeWhitespace(raw[lang] ?? raw.hu ?? raw.en ?? "");
  }
  let s = normalizeWhitespace(raw);
  if (s.startsWith("{") && s.includes('"')) {
    try {
      const obj = JSON.parse(s);
      s = normalizeWhitespace(obj?.[lang] ?? obj?.hu ?? obj?.en ?? "");
    } catch {
      return "";
    }
  }
  // A real slug never contains JSON / URL-breaking characters.
  return /[{}"\s]/.test(s) ? "" : s;
}

function buildDreamJobsUrl(job) {
  // MINDIG a magyar locale-t tároljuk. Korábban a `job.primary_lang` döntött, így egy
  // angol nyelvű hirdetés /en/-re és az ANGOL slugra került (…/en/…/devops-engineer-58),
  // miközben a lista /hu/-t ad (…/hu/…/devops-engineer-56) → ugyanaz az állás két külön
  // sorként is bekerülhetett (DB: 2 db /en/, 6 db /hu/). A site minden hirdetést kiszolgál
  // /hu/-n. Lásd SCRAPER_BUG_INVESTIGATION.md.
  const lang = "hu";
  const companySlug = resolveDreamSlug(job?.company?.slug, lang);
  const localizedSlug =
    resolveDreamSlug(job?.slugs?.[`slug_${lang}`], lang) ||
    resolveDreamSlug(job?.slugs?.slug_hu, lang) ||
    resolveDreamSlug(job?.slugs?.[lang], lang) ||
    resolveDreamSlug(job?.slugs?.hu, lang) ||
    resolveDreamSlug(job?.slugs, lang) ||
    resolveDreamSlug(job?.slug, lang);

  if (!companySlug || !localizedSlug) return null;

  return normalizeUrl(`https://dreamjobs.hu/${lang}/job/${companySlug}/${localizedSlug}`);
}

// /{lang}/job/{company}/{slug}-{n} — the trailing counter BUMPS when the
// company reposts the ad (DB evidence: artofinfo m365-engineer-1 → -2), so the
// url alone can't be the row identity. Company is part of the prefix, so only
// the same company's same slug matches.
//
// The LOCALE segment is deliberately left open (`[a-z]{2}`) instead of being
// escaped into the prefix: buildDreamJobsUrl now always emits /hu/, so the rows
// still stored under /en/ (2 at the time of the fix) have to be able to migrate
// onto their /hu/ url rather than being inserted a second time.
function dreamjobsVolatileUrlPattern(url) {
  const m = url.match(/^https:\/\/dreamjobs\.hu\/[a-z]{2}\/job\/([^/]+)\/(.+)-\d+$/);
  if (!m) return null;
  const [, company, slugBase] = m;
  return `^https://dreamjobs\\.hu/[a-z]{2}/job/${escapeRegex(company)}/${escapeRegex(slugBase)}-\\d+$`;
}

function pickJobTitle(job) {
  const lang = /^[a-z]{2}$/i.test(String(job?.primary_lang || "")) ? String(job.primary_lang).toLowerCase() : "hu";
  return normalizeWhitespace(job?.name?.[lang]) || normalizeWhitespace(job?.name?.hu) || normalizeWhitespace(job?.name?.en) || null;
}

function extractDreamJobs(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : [];

  return rows
    .map((job) => ({
      title: pickJobTitle(job),
      url: buildDreamJobsUrl(job),
      experience: normalizeWhitespace(job?.tags?.job_level?.slug) || null,
      company: (normalizeWhitespace(job?.company?.name) || null)?.slice(0, 200) ?? null,
      categoryId: Number(job?.tags?.job_category?.id),
      categorySlug: normalizeText(job?.tags?.job_category?.slug),
      isBlue: job?.is_blue === true,
    }))
    .filter((item) => item.title && item.url);
}

function isDreamJobsItCategory(job) {
  return (
    DREAMJOBS_IT_CATEGORY_IDS.has(job.categoryId) ||
    DREAMJOBS_IT_CATEGORY_SLUGS.has(job.categorySlug)
  );
}

// Returns { jobs, complete }. `complete` is false when a paging loop ran all the
// way to MAX_PAGES without a natural end — the listing is then TRUNCATED, and
// reconcileActive must not deactivate the rows that fell off the tail. (Same bug
// class that killed 15 live wherewework rows on 2026-07-11: an exhausted page cap
// with no guard reads as "these jobs are gone".)
// Visszaad: { jobs, allUrls, complete }.
// `jobs` = az IT-kategóriás, nem-blue állások (ezeket ingesztáljuk), `allUrls` = MINDEN
// élő hirdetés url-je kategóriától/senior-szűrőtől függetlenül → ez a reconcile bucket
// és a migrateVolatileUrl "él még" halmaza.
//
// A lapozás vége mostantól a szerver `pagination` mezőjéből jön, NEM a
// `pageJobs.length < perPage` heurisztikából: az `extractDreamJobs` kidobja a
// felépíthetetlen url-ű sorokat, így egy teljes oldal is rövidebbnek látszhatott a
// vártnál, és a ciklus "természetes végként" hagyta ott a listát — közben a maradék
// oldalak kimaradtak, `complete:true` mellett. Ma nem harap (59 állás = 1 oldal), de
// pont ez az a néma csonkolás, ami a wherewework-nél 15 élő sort ölt meg.
async function fetchAllDreamJobs() {
  const jobs = [];
  const allUrls = [];
  const seen = new Set();
  const unknownCategories = new Map();
  let complete = true;

  for (const apiUrl of DREAMJOBS_API_URLS) {
    const baseUrl = new URL(apiUrl);
    let naturalEnd = false;

    for (let page = 1; page <= MAX_PAGES; page += 1) {
      baseUrl.searchParams.set("page", String(page));
      const payload = await fetchJson(baseUrl.toString());
      const pageJobs = extractDreamJobs(payload);

      for (const job of pageJobs) {
        const key = normalizeUrl(job.url);
        if (seen.has(key)) continue;
        seen.add(key);
        allUrls.push(key);

        if (!isDreamJobsItCategory(job) && !DREAMJOBS_NON_IT_CATEGORY_IDS.has(job.categoryId)) {
          unknownCategories.set(job.categoryId, job.categorySlug);
        }
        // `scope[]=isNotBlue` kliens-oldali megfelelője.
        if (job.isBlue || !isDreamJobsItCategory(job)) continue;
        jobs.push(job);
      }

      const lastPage = Number(payload?.pagination?.last_page);
      if (Number.isFinite(lastPage) && lastPage > 0) {
        if (page >= lastPage) { naturalEnd = true; break; }
      } else if (pageJobs.length === 0) {
        // Nincs használható pagination → csak az üres oldal a megbízható végjel.
        naturalEnd = true;
        break;
      }
    }

    if (!naturalEnd) {
      complete = false;
      console.warn(`[dreamjobs] page cap (${MAX_PAGES}) exhausted for ${apiUrl} — listing truncated, skipping deactivation`);
    }
  }

  if (unknownCategories.size) {
    const listed = [...unknownCategories].map(([id, slug]) => `${id}=${slug}`).join(", ");
    console.warn(`[dreamjobs] ÚJ, még el nem bírált kategóriában van élő hirdetés: ${listed}`);
  }

  return { jobs, allUrls, complete };
}

/* ── MelonJobs ──────────────────────────────────────────────── */


function isBudapestLocation(location) {
  const normalized = normalizeText(location);
  return normalized.includes("budapest") || /\b1\d{3}\b/.test(normalized);
}

// INTERNSHIP_KEYWORDS imported from _experience_core.mjs


function inferExperience(title, description) {
  const titleNorm = normalizeText(title ?? "");
  const fullNorm = normalizeText(`${title ?? ""} ${description ?? ""}`);

  if (INTERNSHIP_KEYWORDS.some(k => fullNorm.includes(k))) return "diákmunka";
  if (isSeniorTitleFilterMatch(title, _filters)) return "senior";
  if (/\bmedior\b/.test(titleNorm)) return "medior";
  if (/\bjunior\b|\bpalyakezdo\b|\bentry level\b/.test(titleNorm)) return "junior";

  return null;
}

function _blacklistRegex(k) {
  const escaped = normalizeText(k).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i");
}

function isSeniorLike(title, description) {
  return shouldSkipTitleFilter(title, _filters);
}

function extractMelonJobs(payload) {
  const rows = Array.isArray(payload) ? payload : [];

  return rows
    .map((job) => {
      const title = htmlToText(job?.title?.rendered);
      const description = htmlToText(job?.content?.rendered);
      const url = normalizeUrl(job?.link || "");
      const location = normalizeWhitespace(job?.meta?._job_location);
      const company = (normalizeWhitespace(job?.meta?._company_name) || null)?.slice(0, 200) ?? null;

      return {
        title,
        description,
        url,
        location,
        company,
        experience: inferExperience(title, description),
      };
    })
    .filter((job) => job.title && job.url)
    .filter((job) => isBudapestLocation(job.location))
    .filter((job) => !shouldSkipTitleFilter(job.title, _filters));
}

// id → slug. Üres Map = a taxonómia nem érhető el; ilyenkor a hívó csak az
// id-listára támaszkodik (szűkebb találat jobb, mint nulla).
async function fetchMelonCategoryMap() {
  const map = new Map();
  const url = new URL(MELONJOBS_TAXONOMY_URL);
  const perPage = Number.parseInt(url.searchParams.get("per_page") || "100", 10) || 100;

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    url.searchParams.set("page", String(page));
    const terms = await fetchJson(url.toString());
    if (!Array.isArray(terms) || terms.length === 0) break;
    for (const term of terms) map.set(Number(term.id), normalizeText(term.slug || term.name));
    if (terms.length < perPage) break;
  }

  return map;
}

function melonCategoryIds(listing) {
  const raw = listing?.["job-categories"];
  return Array.isArray(raw) ? raw.map(Number).filter(Number.isFinite) : [];
}

function isMelonItCategory(id, catMap) {
  return MELONJOBS_IT_CATEGORY_IDS.has(id) || MELONJOBS_IT_SLUGS.has(catMap.get(id) ?? "");
}

// Visszaad: { jobs, allUrls, complete }.
// `allUrls` = MINDEN élő hirdetés url-je kategóriától/helyszíntől/senior-szűrőtől
// függetlenül — ez a reconcile bucket. `jobs` = a ténylegesen ingesztálandó, már
// szűrt halmaz.
async function fetchAllMelonJobs() {
  let catMap = new Map();
  try {
    catMap = await fetchMelonCategoryMap();
  } catch (err) {
    console.warn(`[melonjobs] taxonomy fetch failed (${err.message}) — csak az id-listával szűrünk`);
  }

  const listings = [];
  const baseUrl = new URL(MELONJOBS_LISTINGS_URL);
  const perPage = Number.parseInt(baseUrl.searchParams.get("per_page") || "100", 10) || 100;
  let naturalEnd = false;

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    baseUrl.searchParams.set("page", String(page));
    const payload = await fetchJson(baseUrl.toString());
    if (!Array.isArray(payload) || payload.length === 0) { naturalEnd = true; break; }

    listings.push(...payload);

    if (payload.length < perPage) { naturalEnd = true; break; }
  }

  if (!naturalEnd) console.warn(`[melonjobs] page cap (${MAX_PAGES}) exhausted — listing truncated, skipping deactivation`);

  const missedItLike = [...new Set(listings.flatMap(melonCategoryIds))]
    .filter((id) => !isMelonItCategory(id, catMap) && MELONJOBS_IT_HINT.test(catMap.get(id) ?? ""))
    .map((id) => `${id}=${catMap.get(id)}`);
  if (missedItLike.length) {
    console.warn(`[melonjobs] IT-szagú, de NEM figyelt kategóriában van élő hirdetés: ${missedItLike.join(", ")}`);
  }

  const itListings = listings.filter((listing) =>
    melonCategoryIds(listing).some((id) => isMelonItCategory(id, catMap))
  );

  return {
    jobs: extractMelonJobs(itListings),
    allUrls: listings.map((listing) => normalizeUrl(listing?.link || "")).filter(Boolean),
    complete: naturalEnd,
  };
}

/* ── KUKA ───────────────────────────────────────────────────── */

function inferKukaExperience(title) {
  const normalized = normalizeText(title);
  if (isSeniorTitleFilterMatch(title, _filters))
    return "senior";
  if (/\bmedior\b|\bmid\b/.test(normalized)) return "medior";
  // kuka "junior" hirdetései gyakornoki-egyenértékűek (üzleti szabály, korábban
  // egy külön futás utáni SQL-lel javítottuk "junior" → "diákmunka"-ra; most
  // rögtön insert előtt a helyes érték kerül be, nincs utólagos patch).
  if (/\bjunior\b|\bpalyakezdo\b|\bentry.?level\b|\btrainee\b|\bintern\b|\bgyakornok\b/.test(normalized))
    return "diákmunka";
  return null;
}

function extractKukaJobs(html) {
  const $ = cheerioLoad(html);
  const jobs = [];
  const seen = new Set();

  $("li[data-url]").each((_i, el) => {
    const $el = $(el);
    const path = $el.attr("data-url");
    if (!path) return;

    const url = normalizeUrl(`https://jobs.kuka.com${path.replace(/&amp;/g, "&")}`);
    if (seen.has(url)) return;
    seen.add(url);

    const title = normalizeWhitespace(
      $el.find(".jobTitle-link").first().text() ||
        $el.find(".title a").first().text() ||
        $el.find("a[href]").first().text()
    );
    if (!title) return;

    // 2026-08-04: the API's own `locationsearch=HU` param isn't reliably honored
    // upstream (live-verified: 3 Augsburg/Germany "Ausbildung" tiles came back
    // through it) — each tile also carries its own Country/Region field, so use
    // that as an independent backstop. Missing field (parse hiccup) fails open.
    const country = normalizeWhitespace(
      $el.find('.section-field.country div[id$="-value"]').first().text()
    );
    if (country && country.toUpperCase() !== "HU") return;

    jobs.push({
      title,
      url,
      experience: inferKukaExperience(title),
    });
  });

  return jobs;
}

// SAP tile-search caps at 25 tiles per response and pages via ?startrow=N.
// A single call only returns the first 25, so we page until a short/empty page.
// Getting the FULL listing is what makes reconcileActive safe for kuka.
const KUKA_PAGE_SIZE = 25;
const KUKA_MAX_PAGES = 20;

// A kuka url-je /job/{slug}/{id}/ — az id STABIL, a slug viszont újragenerálódik
// egy szerkesztett címből. Élő bizonyíték 2026-08-26: a
// /job/Budapest-AMR-Service-Engineer/1363441355/ hirdetés
// /job/Budapest-AMR-Project-Engineer/1363441355/ lett — ugyanaz az id. A kuka
// ág eddig EGYÁLTALÁN nem hívott migrateVolatileUrl-t (a MIX-ben csak a
// dreamjobs kapott ilyet), így az átnevezés árván hagyta a régi sort
// (inaktívan, HTTP 200-zal) és beszúrt egy duplikátumot ugyanarra az állásra —
// ez töri a dedupe-ot és a napi statisztikát. Ugyanaz a fallback, amit az erste
// 2026-07-22-én kapott: bármelyik kuka url, ami ezt az id-t hordozza. Az id
// forráson belül egyedi, és a migrateVolatileUrl sosem nevez át olyan url-t,
// ami még kint van az élő listán, tehát ez nem tud túl-illeszkedni.
function kukaIdOnlyPattern(url) {
  const m = url.match(/\/(\d{6,})\/?$/);
  return m ? `${escapeRegex(`/${m[1]}/`)}$` : null;
}

async function fetchAllKukaJobs() {
  const jobs = [];
  const seen = new Set();
  let naturalEnd = false;
  for (let page = 0; page < KUKA_MAX_PAGES; page += 1) {
    const startrow = page * KUKA_PAGE_SIZE;
    const url = startrow === 0 ? KUKA_API_URL : `${KUKA_API_URL}&startrow=${startrow}`;
    const pageJobs = extractKukaJobs(await fetchText(url));
    let added = 0;
    for (const job of pageJobs) {
      if (seen.has(job.url)) continue;
      seen.add(job.url);
      jobs.push(job);
      added += 1;
    }
    if (pageJobs.length < KUKA_PAGE_SIZE || added === 0) { naturalEnd = true; break; }
  }
  if (!naturalEnd) console.warn(`[kuka] page cap (${KUKA_MAX_PAGES}) exhausted — listing truncated, skipping deactivation`);
  return { jobs, complete: naturalEnd };
}
/* ── handler ────────────────────────────────────────────────── */

const _runJob = withTimeout("cron_jobs_MIX-background", async (request) => {
  _filters = await loadFilters();
  const client = await pool.connect();

  try {
    const { rows: knownRows } = await client.query(
      `SELECT source, url FROM job_posts WHERE source IN ('dreamjobs','melonjobs','kuka')`
    );
    const known = new Map([["dreamjobs", new Set()], ["melonjobs", new Set()], ["kuka", new Set()]]);
    for (const r of knownRows) known.get(r.source)?.add(r.url);

    /* DreamJobs */
    try {
      const { jobs: allDreamJobs, allUrls: currentUrls, complete: dreamComplete } = await fetchAllDreamJobs();
      // `currentUrls` = a teljes élő lista (kategória-szűrés ELŐTT) — egy ebben
      // szereplő url él a forráson, így a migrateVolatileUrl soha nem nevezheti át
      // alóla a sort.
      const dreamJobs = allDreamJobs.filter((job) => {
        if (shouldSkipTitleFilter(job.title, _filters)) return false;
        const exp = String(job.experience || "").toLowerCase();
        if (shouldSkipSeniorExperience(/\bsenior\b/.test(exp))) return false;
        return true;
      });
      console.log(`dreamjobs: ${dreamJobs.length} IT jobs found (of ${currentUrls.length} listed)`);

      // Cross-source duplicate guard (2026-09-04, same pattern as
      // startupjobs/ats-crawl/workable/talent): scoped to the shared
      // CROSS_SOURCE_DUPE_SOURCES list — see _cross_source_dupe.mjs. Checked
      // before enrichIfNew so a confirmed dupe never costs a detail-page fetch.
      const dreamCrossDupeIndex = await loadCrossSourceDupeIndex(client, "dreamjobs", { onlySources: CROSS_SOURCE_DUPE_SOURCES });
      console.log(`[dreamjobs] cross-source dupe index: ${dreamCrossDupeIndex.size} keys`);

      // Same-source duplicate guard (2026-09-04, same pattern as nofluffjobs/
      // startupjobs/LinkedIn/profession-intern): the trailing repost counter
      // in dreamjobs' own url (see dreamjobsVolatileUrlPattern's doc) means a
      // genuinely re-listed ad can still land under a url the volatile-url
      // migration above doesn't catch (e.g. a slug edit alongside the repost).
      const dreamSameSourceDupeIndex = await loadSameSourceDupeIndex(client, "dreamjobs");

      let skippedCrossSourceDupe = 0;
      let skippedSameSourceDupe = 0;
      for (const job of dreamJobs) {
        const pattern = dreamjobsVolatileUrlPattern(job.url);
        if (pattern) {
          const migrated = await migrateVolatileUrl(client, "dreamjobs", job.url, pattern, currentUrls);
          if (migrated) console.log(`[dreamjobs] MIGRATED url → ${job.url}`);
        }

        if (isCrossSourceDupe(dreamCrossDupeIndex, job.company, job.title)) {
          skippedCrossSourceDupe++;
          console.log(`[dreamjobs] SKIP cross-source dupe "${job.title}" @ ${job.company ?? "-"} → ${job.url}`);
          continue;
        }

        await enrichIfNew(job, known.get("dreamjobs"), extractBodyExperience, "cron_jobs_MIX");
        // Ideiglenes döntés (2026-08-01): a senior-flag pontos, de a nem-LinkedIn
        // forrásoknál insert előtt is kizárjuk — ne is kerüljön be a DB-be.
        if (shouldSkipSeniorExperience(isSeniorExperience(job.experience))) continue;

        const sameSourceDupe = findSameSourceDuplicate(dreamSameSourceDupeIndex, job.url, job.company, job.title, job.technologies);
        if (sameSourceDupe) {
          skippedSameSourceDupe++;
          console.log(`[dreamjobs] SKIP same-source dupe "${job.title}" @ ${job.company ?? "-"} — already active at ${sameSourceDupe.url}`);
          continue;
        }

        await upsertJob(client, "dreamjobs", job);
        const key = dupeKey(job.company, job.title);
        if (key) {
          if (!dreamSameSourceDupeIndex.has(key)) dreamSameSourceDupeIndex.set(key, []);
          dreamSameSourceDupeIndex.get(key).push({ url: job.url, technologies: job.technologies });
        }
      }
      console.log(`dreamjobs: ${dreamJobs.length} jobs processed (cross-source skipped=${skippedCrossSourceDupe}, same-source skipped=${skippedSameSourceDupe})`);
      // Reconcile a TELJES élő listával (kategória/senior szűrés előtt): ami még kint
      // van a forráson, az él — ne kapcsoljuk le csak azért, mert a saját szűrőnk
      // kiejtette. (kuka/melonjobs-minta.)
      const rc = await reconcileActive(client, "dreamjobs", currentUrls, { complete: dreamComplete });
      console.log(`[dreamjobs] active reconcile — ${JSON.stringify(rc)}`);
    } catch (err) {
      console.error("dreamjobs fetch failed:", err.message);
    }

    /* MelonJobs */
    try {
      const { jobs: melonJobs, allUrls: melonAllUrls, complete: melonComplete } = await fetchAllMelonJobs();
      console.log(`melonjobs: ${melonJobs.length} IT jobs found (of ${melonAllUrls.length} listed)`);

      for (const job of melonJobs) {
        await enrichIfNew(job, known.get("melonjobs"), extractBodyExperience, "cron_jobs_MIX");
        if (shouldSkipSeniorExperience(isSeniorExperience(job.experience))) continue;
        await upsertJob(client, "melonjobs", job);
      }
      console.log(`melonjobs: ${melonJobs.length} jobs processed`);
      // Reconcile a TELJES élő listával (kategória/helyszín/senior szűrés előtt):
      // ami még kint van a site-on, az él — soha ne kapcsoljuk le csak azért,
      // mert a saját szűrőnk kiejtette. (Ugyanaz az elv, mint a kuka ágon.)
      const rc = await reconcileActive(client, "melonjobs", melonAllUrls, { complete: melonComplete });
      console.log(`[melonjobs] active reconcile — ${JSON.stringify(rc)}`);
    } catch (err) {
      console.error("melonjobs fetch failed:", err.message);
    }

    /* KUKA */
    try {
      // Full paginated listing — the bucket for reconcile. Any fetch error throws
      // out to the catch below, so a partial crawl never reaches reconcileActive.
      const { jobs: allKukaJobs, complete: kukaComplete } = await fetchAllKukaJobs();
      const kukaJobs = allKukaJobs.filter((job) => !shouldSkipTitleFilter(job.title, _filters));
      console.log(`kuka: ${kukaJobs.length} jobs found (of ${allKukaJobs.length} listed)`);

      // A TELJES élő lista (szűrés előtt) a migrálás "él még" halmaza — egy még
      // listázott url-t soha nem nevezhetünk át alóla.
      const kukaCurrentUrls = allKukaJobs.map((j) => j.url);
      for (const job of kukaJobs) {
        await enrichIfNew(job, known.get("kuka"), extractKukaExperience, "cron_jobs_MIX");
        if (shouldSkipSeniorExperience(isSeniorExperience(job.experience))) continue;
        const idPattern = kukaIdOnlyPattern(job.url);
        if (idPattern) {
          const migrated = await migrateVolatileUrl(client, "kuka", job.url, idPattern, kukaCurrentUrls);
          if (migrated) console.log(`[kuka] MIGRATED url → ${job.url}`);
        }
        await upsertJob(client, "kuka", job);
      }
      console.log(`kuka: ${kukaJobs.length} jobs processed`);
      // Reconcile against the FULL listing (incl. senior) so a still-listed job is
      // never wrongly deactivated just because it now matches the senior filter.
      const rc = await reconcileActive(client, "kuka", allKukaJobs.map((j) => j.url), { complete: kukaComplete });
      console.log(`[kuka] active reconcile — ${JSON.stringify(rc)}`);
    } catch (err) {
      console.error("kuka fetch failed:", err.message);
    }
  } finally {
    client.release();
  }

  return new Response("OK");
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
