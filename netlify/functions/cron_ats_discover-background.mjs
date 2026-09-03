/*
  ATS slug-felderítés (WEB_CRAWLER_PLAN.md F2) — az `ats_tenants` tábla
  utánpótlása. Ez a fél DERÍTI FEL a cégeket; a learatásuk a
  cron_jobs_ATSCRAWL-background.mjs dolga.

  Lead-forrás: a SAJÁT `job_posts.company` mezőnk. Több ezer olyan cég van
  benne, amiről bizonyítottan tudjuk, hogy Magyarországon hirdet — ez
  lényegesen jobb kiindulás, mint egy random webcrawl vagy egy általános
  Google-keresés. A cégnévből slug-jelölteket képzünk (_ats_slug_core.mjs), és
  megnézzük, van-e nekik board a három tiszta-404-es provideren.

  Miért működik ez egyáltalán: a 2026-08-26-i kézi próbában 64 találomra
  választott cégnévből 35-nek LÉTEZETT boardja a négy provider valamelyikén
  (~55%). A szűk keresztmetszet nem a board megtalálása, hanem hogy van-e rajta
  MAGYAR hirdetés (35-ből 5) — de ez utóbbit már az ATSCRAWL worker méri fel,
  ingyen, a napi körében.

  Költség-korlátok (mindkettő szándékos):
   • CANDIDATE_INTAKE — futásonként ennyi ÚJ cégnév kerül a jelölt-táblába
   • PROBE_BUDGET     — futásonként ennyi jelöltet próbálunk ki élesben
  Egy jelölt legfeljebb 3 HTTP-kérés (provideronként egy, az első találatnál
  megállunk). A jelölt-tábla miatt ugyanazt a slugot SOHA nem próbáljuk kétszer,
  tehát a cégnév-lista egyszer fut körbe, aztán már csak az újakat nézzük.
*/

import { Pool } from "pg";
import { withTimeout } from "./_error-logger.mjs";
import { candidateSlugs, probeSlug, PROBEABLE_PROVIDERS } from "./_ats_slug_core.mjs";
import {
  readTenants, writeTenants, addTenantIfNew,
  readCandidateState, writeCandidateState, addCandidateIfNew, applyCandidateResult, selectDueCandidates,
} from "./_ats_state.mjs";

const CANDIDATE_INTAKE = Number(process.env.ATS_DISCOVER_INTAKE || 300);
const PROBE_BUDGET = Number(process.env.ATS_DISCOVER_BUDGET || 45);
// Udvariassági szünet két jelölt között (a providerek publikus, ingyenes
// API-jai — nem akarunk sorozatban ezer kérést lőni rájuk).
const PROBE_GAP_MS = 150;
// Hálózati hibára (429/5xx/timeout) a jelölt nem "miss", csak elhalasztjuk.
const RETRY_ERROR_DAYS = 7;

/* ── 2. ÁG: SmartRecruiters globális kereső (2026-08-30) ──────────────────
   A fenti cégnév-tippelés SZÁNDÉKOSAN kihagyja a SmartRecruiterst: ott a
   nemlétező slug is 200-at ad üres listával, tehát a tipp sosem cáfolható
   (ld. _ats_slug_core.mjs fejléc). Emiatt SR-tenant eddig CSAK kézzel
   kerülhetett be — ma összesen kettő van, hardcode-olva a régi
   cron_jobs_ATS-background.mjs-ben (Wise, RolandBerger).

   Van viszont egy publikus, hitelesítés nélküli GLOBÁLIS kereső, ami minden
   találat mellé odaadja a tenant-slugot (`company.identifier`) és a cég
   hiteles nevét (`company.name`):

     GET https://jobs.smartrecruiters.com/sr-jobs/search?keyword=Budapest&limit=100&offset=N

   Élő mérés 2026-08-30: `Budapest` → 22 magyar hirdetéses tenant, `Hungary`
   → 23, a kettő UNIÓJA 31 (pl. Hiflylabs 22 magyar állással, TOPdesk 12,
   Butopa 6 — egyikük sincs ma a rendszerben). A `Magyarország` kulcsszó
   értéktelen (1 találat), ezért nincs a bankban.

   FONTOS — ez FELDERÍTÉS, nem ingest. A `keyword` szöveg-egyezés, nem
   helyszín-szűrő (a location/country/geo paraméterek egyikére sem szűr,
   mind a tízet végigpróbáltam), tehát listázásnak megbízhatatlan és
   reconcile-ra alkalmatlan. A találatból CSAK a tenant-slugot vesszük ki; a
   hirdetéseket utána az ATSCRAWL aratja le a rendes per-cég API-val, ami a
   TELJES boardot adja — azokat a sorokat is, amiknek a szövegében nem
   szerepel a "Budapest" szó.

   A `company` mezőt itt KITÖLTJÜK (ellentétben a slug-tippeléssel, ld. lent
   az addTenant fejlécét): a nevet nem mi találtuk ki egy tippelt slughoz,
   hanem a provider adja a slug mellé — ugyanaz a bizonyíték-erősség, mint a
   Greenhouse `company_name`-jé. */
const SR_QUERY_BANK = ["Budapest", "Hungary"];
const SR_PAGE_LIMIT = 100;
const SR_MAX_PAGES = 8; // kulcsszavanként max 800 sor
const SR_SEARCH_URL = "https://jobs.smartrecruiters.com/sr-jobs/search";
// wise/rolandberger már direktben fel vannak véve az ATSCRAWL SEED_TENANTS
// listájában (2026-09-02, a korábbi külön cron_jobs_ATS-background.mjs
// összevonásakor) — nincs értelme a felderítőnek is jelöltként újra
// megtalálnia és `ats_slug_candidates`-be tennie őket.
const SR_COVERED_ELSEWHERE = new Set(["wise", "rolandberger"]);

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

// 2026-09-03: ats_slug_candidates / ats_seen_companies / ats_tenants mind
// Blobs-ra költöztek (_ats_state.mjs) — nincs séma, ami itt kellene. A
// `provideronkénti könyvelés` (probedProviders tömb) és a "melyik cégnevet
// dolgoztuk már fel" (seenCompanies) logikája szerkezetében változatlan, csak
// a hordozó nem Postgres-oszlop/tábla, hanem blob-mező. Az egyszeri
// visszamenőleges LEGACY_PROBED_PROVIDERS-feltöltés (2026-08-30, a régi
// Postgres-migráció) nem került át — a blob-store frissen jött létre azzal az
// állapottal, amit az akkori egyszeri UPDATE már beírt, tehát a régi jelöltek
// probedProviders-e élesben már a helyes érték.

/**
 * Új slug-jelöltek felvétele a job_posts cégneveiből.
 *
 * Minden feldolgozott cégnév bekerül a `seenCompanies`-be — akkor is, ha nem
 * született belőle egyetlen jelölt sem (csupa általános szó), és akkor is, ha
 * a jelöltjeit egy másik cégnév már felvette. Ez az egyetlen könyvelés, ami
 * garantálja, hogy a cégnév-lista ténylegesen körbeér.
 *
 * A kizárás (mely cégneveket ne hozza vissza a lekérdezés) egyetlen olvasó
 * SQL-lel megy, a blobban tárolt `seenCompanies` kulcsait paraméterként adva
 * — ez az EGYETLEN pont, ahol ez a job Postgrest olvas (a job_posts.company
 * a blob-store-ban nem létezik, azt nem lehet máshonnan levezetni).
 */
async function intakeCandidates(client, state, limit) {
  const seenNames = Object.keys(state.seenCompanies);
  const { rows } = await client.query(
    `SELECT DISTINCT company
       FROM job_posts
      WHERE company IS NOT NULL
        AND length(trim(company)) > 2
        AND company <> ALL($1::text[])
      ORDER BY company
      LIMIT $2`,
    [seenNames, limit]
  );

  let added = 0;
  let unusable = 0;
  for (const { company } of rows) {
    const slugs = candidateSlugs(company);
    if (slugs.length === 0) unusable += 1;
    for (const slug of slugs) {
      if (addCandidateIfNew(state.candidates, slug, company)) added += 1;
    }
    state.seenCompanies[company] = { seenAt: new Date().toISOString(), slugCount: slugs.length };
  }
  return { companies: rows.length, added, unusable };
}

/*
 * FONTOS — a slug-találat NEM azonosítja a céget.
 *
 * A próba annyit bizonyít, hogy `<provider>/<slug>` boardja LÉTEZIK; azt nem,
 * hogy azé a cégé, akinek a nevéből a slugot képeztük. Élő mérés 2026-08-26:
 * a "Cursor Insight Kft."-ből képzett `cursor` slug egy 116 állásos boardot
 * talált el (nyilvánvalóan a Cursor nevű amerikai cégét), az "Icon Group
 * Zrt."-ből az `icon`, a "Kontakt Elektro"-ból a `kontakt` — 45 cégnévből 8
 * board jött, és ebből 4 idegen cégé volt.
 *
 * Ezért a tenant `company` mezője itt SZÁNDÉKOSAN NULL marad: a tippelt nevet
 * sosem állítjuk a hirdetésekről. A cégnevet a provider adja, ha tudja
 * (Greenhouse `company_name`), különben a sor company nélkül marad — pontosan
 * úgy, ahogy az anonim ügyfeles forrásoknál (A_K, schönherz) is. A tippelt név
 * a `discovered_via`-ba kerül, mint eredet-megjegyzés, nem mint tény.
 *
 * A téves boardokat nem is kell külön kiszűrni: az ATSCRAWL worker első körben
 * `no_hu`-ra állítja őket (nincs magyar hirdetésük), és onnantól a lassú, 3
 * naponkénti rotációban ülnek. Ha egyszer mégis nyitnak budapesti pozíciót, azt
 * meg is találjuk — csak épp helyes cégnévvel, nem a tippelttel.
 */
function addTenant(tenants, provider, slug, guessedCompany) {
  return addTenantIfNew(tenants, provider, slug, {
    discoveredVia: `company-probe:${String(guessedCompany ?? "").slice(0, 150)}`,
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── SmartRecruiters-felderítés ─────────────────────────────────────── */

async function srSearchPage(keyword, offset) {
  const url = `${SR_SEARCH_URL}?keyword=${encodeURIComponent(keyword)}&limit=${SR_PAGE_LIMIT}&offset=${offset}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "JobWatcher/1.0 (+https://bakan7.netlify.app)",
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

/**
 * A magyar hirdetéssel rendelkező SR-tenantok begyűjtése a globális keresőből.
 *
 * A `location.country === "hu"` szűrés KÓD-oldali és kötelező: a kulcsszavas
 * találat szövegre illeszkedik, tehát egy "our Budapest office"-t említő
 * müncheni hirdetés is bejönne — a `country` mező viszont a provider strukturált
 * adata, nem szöveg.
 *
 * @returns {Map<string,string>} slug → hiteles cégnév
 */
async function collectSrTenants() {
  const found = new Map();
  for (const keyword of SR_QUERY_BANK) {
    let offset = 0;
    for (let page = 0; page < SR_MAX_PAGES; page += 1) {
      let payload;
      try {
        payload = await srSearchPage(keyword, offset);
      } catch (err) {
        // Egy elhasalt kulcsszó nem viheti magával az egész felderítő futást
        // (a cégnév-tippelő ág független tőle) — naplózzuk és lépünk tovább.
        console.error(`[atsdiscover] SR search "${keyword}" page ${page} failed: ${err.message}`);
        break;
      }
      const content = Array.isArray(payload?.content) ? payload.content : [];
      for (const item of content) {
        if ((item?.location?.country || "").toLowerCase() !== "hu") continue;
        const slug = String(item?.company?.identifier || "").trim();
        const name = String(item?.company?.name || "").replace(/\s+/g, " ").trim();
        if (!slug || SR_COVERED_ELSEWHERE.has(slug.toLowerCase())) continue;
        if (!found.has(slug)) found.set(slug, name || null);
      }
      offset += SR_PAGE_LIMIT;
      if (content.length < SR_PAGE_LIMIT) break;
      await sleep(PROBE_GAP_MS);
    }
    console.log(`[atsdiscover] SR search "${keyword}" → ${found.size} tenant(s) so far`);
  }
  return found;
}

async function discoverSmartRecruiters(tenants) {
  const srTenants = await collectSrTenants();
  let added = 0;
  for (const [slug, company] of srTenants) {
    // A slug az SR saját kanonikus alakja ("Hiflylabs"), és az API
    // kis-nagybetűre érzéketlen (élőben ellenőrizve: `Hiflylabs` és
    // `hiflylabs` ugyanazt a boardot adja), tehát a tárolt alak
    // megjelenítés kérdése, nem működésé.
    if (addTenantIfNew(tenants, "smartrecruiters", slug, { company, discoveredVia: "sr-global-search" })) {
      added += 1;
      console.log(`[atsdiscover] SR tenant added: ${slug} ("${company ?? "?"}")`);
    }
  }
  return { seen: srTenants.size, added };
}

const _runJob = withTimeout("cron_ats_discover-background", async () => {
  let probed = 0;
  let hits = 0;
  let newTenants = 0;
  let errors = 0;

  // Egy olvasás + egy írás store-onként a teljes futásra (2026-09-03,
  // ld. _ats_state.mjs fejléce) — a korábbi Postgres-verzió candidate-enként
  // és tenantonként külön UPDATE/INSERT-et adott ki.
  const tenants = await readTenants();
  let tenantsDirty = false;

  // 2. ág ELŐSZÖR: pár lekérés, és a legjobb hozamú (a tippelés hit-rate-je
  // ~18%, itt minden találat bizonyítottan magyar hirdetéses board).
  const sr = await discoverSmartRecruiters(tenants);
  if (sr.added) tenantsDirty = true;
  console.log(`[atsdiscover] SR global search: ${sr.seen} HU tenant(s) seen, ${sr.added} new`);

  const state = await readCandidateState();
  let candidatesDirty = false;

  const client = await pool.connect();
  try {
    const intake = await intakeCandidates(client, state, CANDIDATE_INTAKE);
    if (intake.companies > 0) candidatesDirty = true;
    console.log(`[atsdiscover] intake: ${intake.companies} new company name(s) → ${intake.added} candidate slug(s), ${intake.unusable} name(s) yielded none`);
  } finally {
    client.release();
  }

  const candidates = selectDueCandidates(state.candidates, {
    limit: PROBE_BUDGET,
    retryErrorDays: RETRY_ERROR_DAYS,
    probeableProviders: PROBEABLE_PROVIDERS,
  });
  console.log(`[atsdiscover] probing ${candidates.length} candidate(s)`);

  for (const { slug, sourceCompany: company, probedProviders: already } of candidates) {
    let outcome = "miss";
    let hitProvider = null;
    let sawError = false;

    // Csak azt próbáljuk, amit erre a slugra még nem kérdeztünk meg. Egy
    // provider-bővítés után a régi jelöltek így 1 kérésbe kerülnek, nem
    // annyiba, ahány providerünk van.
    const done = new Set(already || []);
    const todo = PROBEABLE_PROVIDERS.filter((p) => !done.has(p));
    const tried = [...done];

    for (const provider of todo) {
      const r = await probeSlug(provider, slug);
      // A hálózati hiba NEM válasz: ilyenkor a providert szándékosan nem
      // könyveljük elpróbáltként, különben a 7 nap múlva újra sorra kerülő
      // `error` sornak üres lenne a todo-ja, és próbálkozás nélkül csúszna át
      // "miss"-be.
      if (r === "error") { sawError = true; continue; }
      tried.push(provider);
      if (r === "hit") { outcome = "hit"; hitProvider = provider; break; }
    }
    // Hálózati hiba mellett a "miss" nem bizonyíték — maradjon újrapróbálható.
    if (outcome === "miss" && sawError) outcome = "error";

    probed += 1;
    if (outcome === "hit") {
      hits += 1;
      const added = addTenant(tenants, hitProvider, slug, company);
      if (added) { newTenants += 1; tenantsDirty = true; }
      console.log(`[atsdiscover] HIT ${hitProvider}/${slug} (from "${company}")${added ? " → tenant added" : " (already tracked)"}`);
    } else if (outcome === "error") {
      errors += 1;
    }
    applyCandidateResult(state.candidates, slug, outcome, hitProvider, tried);
    candidatesDirty = true;
    await sleep(PROBE_GAP_MS);
  }

  if (tenantsDirty) await writeTenants(tenants);
  if (candidatesDirty) await writeCandidateState(state);

  console.log(
    `[atsdiscover] DONE — probed=${probed} hits=${hits} new_tenants=${newTenants} errors=${errors}`
  );

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
