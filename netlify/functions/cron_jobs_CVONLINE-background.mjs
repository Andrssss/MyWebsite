/*
  cvonline.hu – "IT / Informatika" kategória scraper

  ⚠️ NINCS ÜTEMEZVE (2026-09-15). Élő smoke-teszt (tmp-cvonline-fetch-debug)
  kiderítette, hogy a cvonline.hu a Netlify Lambda egress IP-ket egy saját
  JS-es kihívó oldalra (`/botchallenge.html?token=...`) irányítja át — sima
  szerveroldali `fetch()`-csel megválaszolhatatlan (böngésző-JS futtatás
  kellene hozzá, gomb-kattintás-szimulációval). Otthoni gépről / WebFetch-ből
  indítva a kategória-oldal tökéletesen normális, szerveroldalon renderelt
  HTML-t ad (ezért nézett ki élesben is scrapelhetőnek a ROI-vizsgálat
  során) — a blokk KIFEJEZETTEN a datacenter/felhő-IP-kre szól, ugyanaz a
  hibaosztály, mint `allasportal`-nál (ld. CRON_SCHEDULE.md, "ELENGEDVE").
  A kód a lenti leírás szerint működne, HA a fetch átjutna a kihívón — a
  fájl a repóban marad, de a cron_scheduler.mjs GRID-jéből ki van hagyva.
  Újra bekötni csak akkor érdemes, ha kerül elé egy proxy/headless-browser
  megoldás (ugyanaz a nyitott kérdés, mint allasportalnál).

  Statikus, szerveroldalon renderelt HTML (Drupal), lapozható lista:
    https://www.cvonline.hu/hu/allashirdetesek/it-informatika-0?page=N  (0-indexelt)

  ROI-vizsgálat 2026-09-15 (élő scrape + DB-összevetés, lásd cvonline
  topic-memory): 278 hirdetésből csak 150 magyar — a kategóriát egy OSZTRÁK
  portálhálózattal (pl. "Laendle") osztják meg, 128 sor (46%) Ausztria.
  Emiatt minden sort a saját `location` mezője alapján szűrünk: a listaoldal
  ADJA a helyszínt (nem kell rá heurisztika), csak a külföldi kizárás kell.

  Cégnév: a lista tartalmazza, de GYAKRAN a posztoló HR-ügynökség neve
  (Randstad, Trenkwalder, Hire-One, Pannonjob, stb.), nem a végső
  munkáltatóé — ugyanaz a mintázat, mint az ats-crawl/talent/startupjobs
  forrásoknál. Ezért a megosztott cross-source dupe guard is be van kötve
  (lásd _cross_source_dupe.mjs); a live audit 31/150 magyar sort talált,
  ami már a minddiak/muisz/trenkwalder forrásokon ismétlődött — ez a három
  forrás emiatt felkerült a közös CROSS_SOURCE_DUPE_SOURCES listára is.

  URL-identitás: `/hu/allas/<cimbol-kepzett-szlug>-<node-id>` — a node-id
  Drupal node id, valószínűleg stabil, de cím-átíráskor a szlug-rész
  elméletileg változhat. Nincs migrateVolatileUrl bekötve (v1) — ha élőben
  churn mutatkozik, ugyanaz a minta alkalmazható, mint workday/recruitee-nél
  (_ats_providers.mjs).

  Leírás-konténer a detail-oldalon: `.recruiter_job_template` — élőben
  ellenőrizve, hogy a "hasonló állások" doboz csak egy "kérj értesítőt"
  widget, MÁS hirdetés címét nem tartalmazza, tehát a pollution-kockázat
  alacsony; mégis scope-olva marad (ugyanaz a "wrap + .description" trükk,
  amit a trenkwalder-scraper is használ extractTechnologies-hoz).

  Tapasztalati szint: cím-alapú (isInternshipTitle/isJuniorTitle/
  isMidLevelTitle), ha egyik sem talál, a scope-olt leírásból extractBody-
  Experience ad "N+ years" jellegű nyers jelzést. A "senior"/"lead" című
  hirdetéseket a shouldSkipTitleFilter (job_filters denylist) már a lista-
  szinten kiszűri — ugyanaz a közös mechanizmus, mint minden más forrásnál.
*/

import { Pool } from "pg";
import { load as cheerioLoad } from "cheerio";
import { loadFilters } from "./load_filters.mjs";
import { withTimeout } from "./_error-logger.mjs";
import { reconcileActive } from "./_active_core.mjs";
import { isBlockedCompany } from "./_company_blocklist.mjs";
import { loadCrossSourceDupeIndex, isCrossSourceDupe, isCrossSourceUrlDupe, CROSS_SOURCE_DUPE_SOURCES } from "./_cross_source_dupe.mjs";
import {
  isInternshipTitle,
  isJuniorTitle,
  isMidLevelTitle,
  extractTechnologies,
  extractBodyExperience,
  ensureTechnologiesColumn,
  ensureLevelColumn,
  withTitleTechnologies,
} from "./_experience_core.mjs";
import { shouldSkipTitleFilter, seniorAwareExperience } from "./_seniority_policy.mjs";
import { computeLevel } from "../../src/lib/experienceLevel.mjs";

let _filters = [];

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

const SOURCE = "cvonline";
const CATEGORY_URL = "https://www.cvonline.hu/hu/allashirdetesek/it-informatika-0";
const MAX_PAGES = 30;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// Élőben mért idegen helyszín (2026-09-15): kizárólag "Austria" fordult elő a
// magyar városok/megyék mellett. Blocklist, nem allowlist — egy magyar
// településnevet felsorolni kockázatosabb (könnyen kimarad egy), mint egy
// ismert külföldi szót kizárni.
const FOREIGN_LOCATION_RE = /austria|österreich|osterreich/i;

/* ── helpers ─────────────────────────────────────────────────── */

function normalizeWhitespace(v) {
  return String(v ?? "").replace(/\s+/g, " ").trim();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

function categoryPageUrl(page) {
  return page === 0 ? CATEGORY_URL : `${CATEGORY_URL}?page=${page}`;
}

function parseListingPage(html) {
  const $ = cheerioLoad(html);
  const jobs = [];
  $("article.node--job-per-template").each((_i, el) => {
    const $article = $(el);
    const about = $article.attr("about");
    if (!about) return;
    const url = `https://www.cvonline.hu${about}`;
    const title = normalizeWhitespace($article.find("h2.node__title a").first().text());
    if (!title) return;
    const company =
      normalizeWhitespace($article.find(".recruiter-company-profile-job-organization a").first().text()) || null;
    const location = normalizeWhitespace($article.find(".location span").first().text()) || null;
    jobs.push({ url, title, company, location });
  });
  return jobs;
}

async function fetchAllListings() {
  const all = [];
  const seen = new Set();
  let complete = true;

  for (let page = 0; page < MAX_PAGES; page++) {
    let html;
    try {
      html = await fetchText(categoryPageUrl(page));
    } catch (err) {
      console.warn(`[cvonline] page ${page} fetch failed: ${err.message}`);
      complete = false;
      break;
    }
    const jobs = parseListingPage(html);
    if (jobs.length === 0) {
      console.log(`[cvonline] page ${page}: 0 jobs, stopping`);
      break;
    }
    let added = 0;
    for (const job of jobs) {
      if (seen.has(job.url)) continue;
      seen.add(job.url);
      all.push(job);
      added++;
    }
    console.log(`[cvonline] page ${page}: ${jobs.length} jobs, ${added} new (total ${all.length})`);
    await sleep(300);
  }

  return { jobs: all, complete };
}

/* ── detail fetch (only for genuinely new postings) ─────────────── */

function extractCvonlineDescriptionHtml(html) {
  const $ = cheerioLoad(html);
  return $(".recruiter_job_template").first().html() || "";
}

async function enrichFromDetail(job) {
  const html = await fetchText(job.url);
  const scoped = extractCvonlineDescriptionHtml(html);
  const wrapped = `<div class="description">${scoped}</div>`;
  return {
    technologies: extractTechnologies(wrapped),
    bodyExperience: extractBodyExperience(wrapped),
  };
}

function inferTitleExperience(title) {
  if (isInternshipTitle(title)) return "diákmunka";
  if (isJuniorTitle(title)) return "junior";
  if (isMidLevelTitle(title)) return "medior";
  return null;
}

/* ── db ──────────────────────────────────────────────────────── */

async function upsertJob(client, item) {
  const experience = seniorAwareExperience(item.title, item.experience) ?? "-";
  await client.query(
    `INSERT INTO job_posts (source, title, url, experience, company, technologies, level, first_seen)
     VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
     ON CONFLICT (source, url) DO NOTHING;`,
    [
      SOURCE,
      item.title,
      item.url,
      experience,
      item.company ?? null,
      withTitleTechnologies(item.technologies, item.title),
      computeLevel({ title: item.title, experience, source: SOURCE }),
    ]
  );
}

/* ── handler ─────────────────────────────────────────────────── */

const _runJob = withTimeout("cron_jobs_CVONLINE-background", async () => {
  _filters = await loadFilters();
  const client = await pool.connect();

  let newlyInserted = 0;
  let alreadyKnown = 0;
  let skippedFilter = 0;
  let skippedForeign = 0;
  let skippedBlockedCompany = 0;
  let skippedCrossSourceDupe = 0;
  let detailFetchFailed = 0;
  let skippedIncomplete = 0;

  try {
    await ensureTechnologiesColumn(client);
    await ensureLevelColumn(client);

    const { jobs: rawJobs, complete } = await fetchAllListings();

    const huJobs = rawJobs.filter((j) => {
      if (FOREIGN_LOCATION_RE.test(j.location || "")) {
        skippedForeign++;
        return false;
      }
      return true;
    });

    const candidates = huJobs.filter((j) => {
      if (shouldSkipTitleFilter(j.title, _filters)) {
        skippedFilter++;
        return false;
      }
      if (isBlockedCompany(j.company, SOURCE)) {
        skippedBlockedCompany++;
        return false;
      }
      return true;
    });

    const foundUrls = candidates.map((j) => j.url);

    const { rows: knownRows } = await client.query(
      `SELECT url FROM job_posts WHERE source = $1 AND url = ANY($2::text[])`,
      [SOURCE, foundUrls]
    );
    const known = new Set(knownRows.map((r) => r.url));

    const crossDupeIndex = await loadCrossSourceDupeIndex(client, SOURCE, { onlySources: CROSS_SOURCE_DUPE_SOURCES });
    console.log(`[cvonline] cross-source dupe index: ${crossDupeIndex.keySet.size} keys / ${crossDupeIndex.urlSet.size} urls`);

    for (const job of candidates) {
      if (known.has(job.url)) {
        alreadyKnown++;
        continue;
      }

      if (isCrossSourceUrlDupe(crossDupeIndex, job.url)) {
        skippedCrossSourceDupe++;
        console.log(`[cvonline] SKIP exact-url dupe (already on another source) → ${job.url}`);
        continue;
      }

      if (isCrossSourceDupe(crossDupeIndex, job.company, job.title)) {
        skippedCrossSourceDupe++;
        console.log(`[cvonline] SKIP cross-source dupe "${job.title}" @ ${job.company ?? "-"} → ${job.url}`);
        continue;
      }

      let technologies = null;
      let experience = inferTitleExperience(job.title);
      try {
        await sleep(400);
        const detail = await enrichFromDetail(job);
        technologies = detail.technologies;
        if (!experience) experience = detail.bodyExperience || "-";
      } catch (err) {
        detailFetchFailed++;
        console.warn(`[cvonline] detail fetch failed: ${job.url} — ${err.message}`);
        experience = experience || "-";
      }

      // Insert-only forrás (nincs utólagos UPDATE) — ha sem technológia, sem
      // tapasztalat nem jött át, a sor véglegesen csonka maradna. Ehelyett
      // kihagyjuk (LinkedIn-minta, 2026-09-04/09-15 user-jelzés): a job.url
      // nincs `known`-ban, a következő futás újnak látja és újrapróbálja.
      if (!technologies && experience === "-") {
        skippedIncomplete++;
        console.log(`[cvonline] SKIP incomplete detail fetch (no tech, no experience) — retry later: ${job.url}`);
        continue;
      }

      await upsertJob(client, { ...job, experience, technologies });
      newlyInserted++;
      console.log(`[cvonline] NEW "${job.title}" @ ${job.company ?? "-"} exp=${experience} tech=[${technologies ?? "-"}] → ${job.url}`);
    }

    console.log(
      `[cvonline] DONE — new=${newlyInserted}, known=${alreadyKnown}, ` +
      `skipped_filter=${skippedFilter}, skipped_foreign=${skippedForeign}, ` +
      `skipped_blocked_company=${skippedBlockedCompany}, skipped_cross_dupe=${skippedCrossSourceDupe}, ` +
      `detail_fetch_failed=${detailFetchFailed}, skipped_incomplete=${skippedIncomplete}, complete=${complete}`
    );

    const rc = await reconcileActive(client, SOURCE, foundUrls, { complete });
    console.log(`[cvonline] active reconcile — complete=${complete}, ${JSON.stringify(rc)}`);
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
