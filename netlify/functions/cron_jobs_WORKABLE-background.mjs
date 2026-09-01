/*
  Workable — ORSZÁGOS feed, cég-slug nélkül.  (WEB_CRAWLER_PLAN.md F5)

  Miben más ez, mint a cron_jobs_ATSCRAWL?  Ott a modell az, hogy ISMERNI kell a
  cég board-slugját (ashby/greenhouse/lever/smartrecruiters), és a slug
  utánpótlása külön felderítő-munka — vagyis csak olyan cégeket látunk, akiket
  már amúgy is scrapelünk.  A Workable ezzel szemben publikus, hitelesítés
  nélküli, ORSZÁGRA szűrhető kereső-API-t ad: egyetlen lapozott lekérdezés
  visszaadja az ÖSSZES magyarországi hirdetést, az összes tenantjától.

  Élő mérés 2026-08-30 (curl):
    GET https://jobs.workable.com/api/v1/jobs?location=Hungary
      → 200, 396 hirdetés / 76 cég / 20 lap, `nextPageToken` lapozással.
      → a LISTA hozza a leírást is (description + requirementsSection), tehát
        NULLA detail-hívás kell: a sor teljesen összeáll insert előtt
        (experience-write-policy).
      → mezők: title, url, company.title, location{city,subregion,countryName},
        locations[], workplace, employmentType, created.

  ── Forrás-invariánsok ────────────────────────────────────────────────────
  • `url` = https://jobs.workable.com/view/<id>/<slug>.  A záró slug KOZMETIKAI:
    élőben igazolt, hogy tetszőleges slug 200-at ad és a valódira kanonizál
    (/view/<jó id>/zzz → 200 + redirect a rendes slugra), tehát a sor-identitás
    az `id`, a slug pedig a cím/cég/város változásakor ÁTÍRÓDIK.  Ezért kötelező
    a `migrateVolatileUrl` — enélkül minden címszerkesztés új sort szülne, és a
    régi churn-ölne (CLAUDE.md "volatile URL" invariáns).
  • Nemlétező id → tiszta 404 (élőben igazolt), tehát a napi 404-sweep magától
    működik ezen a forráson; nem kell se BANNER_DEAD, se REDIRECT_DEAD szabály.
  • Helyszín: **CSAK Budapest** (user-döntés 2026-08-30) — `rejectNonBudapest`
    a _ats_location.mjs-ből.  A feed egész Magyarországra szűr, és a sorok jó
    részének üres a `city` mezője; a fail-closed kapu ezeket eldobja.
  • Az `ingestJobs`-nak a TELJES magyar listát átadjuk, nem csak a budapesti
    sorokat: a `foundUrls` (amiből a reconcile dolgozik) szándékosan
    szűrés ELŐTTI halmaz, így egy kapu-változás vagy egy Budapestről elköltöző
    hirdetés nem deaktivál élő sorokat.  A nem-budapesti sorokat üres vázként
    adjuk át (nincs technologies-kinyerés) — úgyis a helyszín-kapun elvéreznek.
  • `fullListing` CSAK akkor igaz, ha a lapozás magától ért véget (nem a
    MAX_PAGES cap miatt) ÉS egyetlen lap sem hibázott.  Cap-kimerülés még
    érvényes tokennel = csonka listázás → complete:false (a wherewework-lecke:
    guard nélküli cap-kimerülés élő sorokat deaktivált).
*/

import { Pool } from "pg";
import { loadFilters } from "./load_filters.mjs";
import { loadCategories } from "./load_categories.mjs";
import { withTimeout } from "./_error-logger.mjs";
import { migrateVolatileUrl, escapeRegex } from "./_active_core.mjs";
import { extractBodyExperience, extractTechnologies } from "./_experience_core.mjs";
import { rejectNonBudapest } from "./_ats_location.mjs";
import { loadCrossSourceDupeIndex, isCrossSourceDupe } from "./_cross_source_dupe.mjs";
import { ingestJobs, normalizeUrl } from "./_ai_ingest_core.mjs";

export const WORKABLE_SOURCE = "workable";

const API_URL = "https://jobs.workable.com/api/v1/jobs";
// Országra szűrünk, a városra NEM: a szerveroldali város-szűrő viselkedése
// nincs igazolva, a 20 lap pedig olcsó — a Budapest-kapu nálunk fut le
// (fetch-all + client-side filter, ugyanaz a minta, mint a MIX-forrásoknál).
const LOCATION_QUERY = "Hungary";
// 20 lap × 20 = 396 hirdetés volt a 08-30-i mérés. A cap ennek a háromszorosa,
// hogy a növekedés ne érje el; ha mégis, a `complete` FALSE lesz (lásd lent).
const MAX_PAGES = 60;
const PAGE_GAP_MS = 150;
const FETCH_TIMEOUT_MS = 20000;

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchPage(pageToken) {
  const url = new URL(API_URL);
  url.searchParams.set("location", LOCATION_QUERY);
  if (pageToken) url.searchParams.set("pageToken", pageToken);
  const res = await fetch(url, {
    headers: {
      "User-Agent": "JobWatcher/1.0 (+https://bakan7.netlify.app)",
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

/**
 * A teljes magyar lista, lapozva.
 * @returns {{jobs: object[], complete: boolean, pages: number, total: number|null}}
 */
async function fetchAllHungarianJobs() {
  const jobs = [];
  const seen = new Set();
  let pageToken = null;
  let pages = 0;
  let total = null;
  let complete = false;

  while (pages < MAX_PAGES) {
    let payload;
    try {
      payload = await fetchPage(pageToken);
    } catch (err) {
      console.error(`[workable] page ${pages} failed: ${err.message}`);
      return { jobs, complete: false, pages, total };
    }
    pages += 1;
    if (total === null && Number.isFinite(Number(payload?.totalSize))) total = Number(payload.totalSize);

    const batch = Array.isArray(payload?.jobs) ? payload.jobs : [];
    for (const j of batch) {
      if (!j || j.state !== "published" || !j.url || !j.title) continue;
      if (seen.has(j.url)) continue; // a lapozás átfedhet — az url a sor-identitás
      seen.add(j.url);
      jobs.push(j);
    }

    pageToken = payload?.nextPageToken || null;
    // Természetes vég: nincs több token, vagy a lap már nem hozott semmit.
    if (!pageToken || batch.length === 0) { complete = true; break; }
    await sleep(PAGE_GAP_MS);
  }

  // Ha a cap miatt léptünk ki, MÉG VAN token → csonka lista, sosem teljes.
  if (!complete) console.warn(`[workable] pagination cap (${MAX_PAGES}) reached with more pages pending`);
  return { jobs, complete, pages, total };
}

/* A helyszín MINDEN alakja egy stringbe: a `locations` tömb ("Budapest,
   Budapest, Hungary") ÉS a strukturált `location` objektum. Azért mindkettő,
   mert a multi-location hirdetésnél a `location` csak az ELSŐDLEGES helyet
   mutatja — a kapunak pont a "Budapest MELLETT van-e másik város" esetet kell
   látnia (ugyanaz a szerződés, mint az _ats_providers.mjs adaptereinél). */
function buildLocation(j) {
  const parts = [];
  if (Array.isArray(j.locations)) parts.push(...j.locations);
  const l = j.location || {};
  parts.push([l.city, l.subregion, l.countryName].filter(Boolean).join(", "));
  const seen = new Set();
  return parts
    .map((p) => String(p ?? "").replace(/\s+/g, " ").trim())
    .filter((p) => p && !seen.has(p.toLowerCase()) && seen.add(p.toLowerCase()))
    .join(" | ");
}

// /view/<id>/<slug> — az id állandó, a slug átíródik cím-/cégnév-változáskor.
function volatilePattern(url) {
  const m = String(url).match(/^(https:\/\/jobs\.workable\.com\/view\/[^/]+\/).+$/);
  return m ? `^${escapeRegex(m[1])}.+$` : null;
}

const _runJob = withTimeout("cron_jobs_WORKABLE-background", async () => {
  const [filters, categories] = await Promise.all([loadFilters(), loadCategories()]);

  const { jobs: raw, complete, pages, total } = await fetchAllHungarianJobs();
  console.log(`[workable] fetched ${raw.length} HU postings on ${pages} page(s) (totalSize=${total ?? "?"}, complete=${complete})`);

  // Sorok felépítése. A budapestieket TELJESEN felépítjük (leírásból experience
  // + technologies), a többit vázként adjuk tovább — azok csak a foundUrls-t
  // (reconcile-halmazt) töltik, a helyszín-kapun úgyis kiesnek.
  const rows = [];
  const budapestUrls = [];
  for (const j of raw) {
    const url = normalizeUrl(j.url) || j.url;
    const location = buildLocation(j);
    if (rejectNonBudapest(location)) {
      rows.push({ title: String(j.title).slice(0, 300), url, location, company: null });
      continue;
    }
    const html = [j.description, j.requirementsSection].filter(Boolean).join(" ");
    rows.push({
      title: String(j.title).replace(/\s+/g, " ").trim().slice(0, 300),
      url,
      company: (j.company?.title || "").replace(/\s+/g, " ").trim().slice(0, 200) || null,
      location,
      experience: (html ? extractBodyExperience(html) : null) || "-",
      technologies: html ? extractTechnologies(html) : null,
    });
    budapestUrls.push(url);
  }

  const budapestUrlSet = new Set(budapestUrls);
  console.log(`[workable] budapest rows: ${budapestUrls.length} / ${rows.length}`);

  const client = await pool.connect();
  try {
    /* Kereszt-forrás duplikátum-szűrő (ugyanaz a mechanizmus, amit a
       startupjobs kapott 2026-08-28-án).  Élő mérés 2026-08-30: a 186 budapesti
       hirdetésből **40** már fent volt a táblán ugyanazzal a cég+cím párral,
       más forrásból (mp solutions 35 sor talent/alllocaljobs/LinkedIn alól,
       pepperstone, turbine, mito…) — ezek a boardon duplikátumként jelennének
       meg.  A 22%-os átfedés jóval kisebb, mint a startupjobs 80%-a, tehát a
       forrás NEM redundáns, csak van egy átfedő sávja; a guard pont ezt vágja le.

       Két tudatosan vállalt következmény (a startupjobs-döntéssel azonosan):
        • az index az INAKTÍV sorokat is tartalmazza, tehát egy régen lejárt,
          azonos cég+cím párú hirdetés is elnyom egy friss workable-sort;
        • a kiszűrt sor kimarad a `foundUrls`-ből is, tehát ha egy már bekerült
          workable-sort később egy másik forrás is megtalál, a reconcile
          deaktiválja a workable-példányt.  Ez a szándékolt viselkedés (a
          duplikátum eltűnik a boardról), nem hiba.
       Kikapcsolni = ezt a blokkot és a `dupe`-szűrést kivenni; a többi kód nem függ tőle. */
    const dupeIndex = await loadCrossSourceDupeIndex(client, WORKABLE_SOURCE);
    console.log(`[workable] cross-source dupe index: ${dupeIndex.size} keys`);
    let skippedDupe = 0;
    const deduped = rows.filter((r) => {
      if (!budapestUrlSet.has(r.url)) return true; // nem-budapesti váz: a reconcile-halmazt tölti
      if (!isCrossSourceDupe(dupeIndex, r.company, r.title)) return true;
      skippedDupe += 1;
      console.log(`[workable] SKIP cross-source dupe "${r.title}" @ ${r.company}`);
      return false;
    });
    console.log(`[workable] cross-source dupes skipped: ${skippedDupe}`);

    // Slug-átírás migrálása CSAK a budapesti sorokra: csak ezeknek lehet
    // tárolt sora, és így a futásonkénti extra query-k száma tucatnyi marad.
    // A `currentUrls` védőlista a TELJES aktuális halmaz (a duplikátumnak
    // minősített sorokkal együtt), nehogy a migráció egy épp látott hirdetés
    // sorát írja át egy másikéra.
    const allUrls = rows.map((r) => r.url);
    for (const row of deduped) {
      if (!budapestUrlSet.has(row.url)) continue;
      const pattern = volatilePattern(row.url);
      if (!pattern) continue;
      const migrated = await migrateVolatileUrl(client, WORKABLE_SOURCE, row.url, pattern, allUrls);
      if (migrated) console.log(`[workable] MIGRATED url → ${row.url}`);
    }

    const result = await ingestJobs(client, {
      source: WORKABLE_SOURCE,
      jobs: deduped,
      fullListing: complete,
      filters,
      categories,
      rejectLocation: rejectNonBudapest,
    });

    console.log(
      `[workable] DONE — rows=${result.rows} dupes=${skippedDupe} inserted=${result.inserted} nonIt=${result.skippedNonIt} ` +
      `filtered=${result.skippedSenior} location=${result.skippedLocation} company=${result.skippedCompany} ` +
      `reconcile=${JSON.stringify(result.reconcile)}`
    );
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
