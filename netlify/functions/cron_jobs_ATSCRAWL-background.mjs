/*
  ATS-crawl — több cég publikus ATS-board API-jának aratása egy forrásba.
  Terv: WEB_CRAWLER_PLAN.md (F1). Adapterek: _ats_providers.mjs.

  Mit csinál:
    ats_tenants (provider + cég-slug, 2026-09-03 óta Blobs, ld. _ats_state.mjs)
    → futásonként BATCH_SIZE tenant → egy lista-hívás boardonként → szigorú
    HU-helyszín kapu → (ha kell) EGY detail-hívás soronként → ingestJobs.

  Miért nem "web crawler": nincs frontier, nincs link-bejárás. A cég-slug az
  egyetlen bemenet, a board API pedig egy körben adja a teljes nyitott listát.
  A slugok utánpótlása külön feladat (F2, kereső-alapú felderítés) — ez a worker
  csak azt aratja le, ami a táblában van.

  ── Forrás-invariánsok (CLAUDE.md "Scraper invariants") ──────────────────
  • EGY `source` érték ("ats-crawl") mind a több száz tenantra, mert forrásonként
    külön érték szétverné a job_daily_stats-ot és a UI forrás-listáját. Emiatt a
    reconcile KÖTELEZŐEN scope-olt (scopePrefix = a board url-előtagja): source-
    szintű reconcile-lal a 2. tenant kikapcsolná az 1. találatait — ez pontosan a
    DEACTIVATION_AUDIT.md Cat-5 hibája (két scraper egy source-on).
  • Az előtag NEM hardcode-olt, hanem a ténylegesen visszakapott url-ekből
    származik (deriveScopePrefix). Ha nem egységes → complete:false, azaz inkább
    nem deaktiválunk, mint rosszul.
  • ÜRES board → SOSEM deaktiválunk (complete:false). SmartRecruiters-nél a
    nemlétező cég is 200 + üres listát ad (élőben igazolt 2026-08-26), tehát az
    "üres" sosem bizonyíték. A halott sorokat a napi 404-sweep viszi el.
  • A sor az insert ELŐTT teljesen összeáll (experience-write-policy): a
    detail-hívás a HU-szűrés után, de az ingest előtt fut, külön
    fetch-then-UPDATE nincs.
  • Helyszín: a szigorított, FAIL-CLOSED kapu (_ats_location.mjs) — user-döntés
    2026-08-26, üres helyszín itt ELDOBÁS, a rendszer többi részével ellentétben.
  • Senior: NEM dobjuk el (2026-08-25-i szabály) — az ingestJobs
    seniorAwareExperience-e címkézi, a frontend rejti.

  2026-09-02: a board nem-IT sorai (amiket az ingestJobs isItJob-kapuja amúgy
  is eldob) NEM vesznek el — ha a cím a marketing_scraper testvérprojekt
  hatókörébe esik (_marketing_match.mjs, marketing/sales/HR/admin), a worker
  átadja őket a marketing_scraper saját ai-ingest.mjs végpontjának
  (_marketing_handoff.mjs, `source: "ATS"`). Ez pontosan az a lista-hívás,
  amit a marketing_scraper korábbi, önálló ATS-crawlere is elvégzett volna
  ugyanezekre a boardokra — a duplikált crawlelést törölve, egy lekérés két
  célra megy. A hand-off fail-soft: hiba esetén csak naplóz, az IT-oldalt
  nem érinti.
*/

import { Pool } from "pg";
import { loadFilters } from "./load_filters.mjs";
import { loadCategories } from "./load_categories.mjs";
import { withTimeout } from "./_error-logger.mjs";
import { migrateVolatileUrl, escapeRegex } from "./_active_core.mjs";
import { extractBodyExperience, extractTechnologies } from "./_experience_core.mjs";
import { getProvider, deriveScopePrefix } from "./_ats_providers.mjs";
import { addTenantIfNew, applyTenantResult, selectDueTenants, readTenants, writeTenants } from "./_ats_state.mjs";
import { rejectAtsLocation } from "./_ats_location.mjs";
import { ingestJobs, normalizeUrl, isItJob } from "./_ai_ingest_core.mjs";
import {
  loadCrossSourceDupeIndex,
  isCrossSourceDupe,
  CROSS_SOURCE_DUPE_SOURCES,
} from "./_cross_source_dupe.mjs";
import { isInScopeTitle } from "./_marketing_match.mjs";
import { postMarketingCandidates } from "./_marketing_handoff.mjs";

export const ATS_SOURCE = "ats-crawl";

// ats-crawl aratja a cégek SAJÁT board-jait, de ugyanazok a pozíciók gyakran
// felbukkannak máshol is, mielőtt idekerülnének — user-megfigyelés 2026-09-02.
// A megosztott CROSS_SOURCE_DUPE_SOURCES listát használja (ugyanaz, mint a
// startupjobs/workable guard-ja, ld. _cross_source_dupe.mjs) — nem "minden más
// forrás": a query így néhány sorra korlátozódik a teljes tábla helyett, saját
// forrásunk (ats-crawl) pedig automatikusan kiesik az összehasonlításból. A
// kulcs company+title, tehát egy tenant board-ján lévő sor akkor esik ki, ha a
// listán szereplő valamelyik forráson már szerepel ugyanaz a cég (első szó) +
// ugyanaz a pozíció (normalizált cím).

// Hány tenantot dolgozunk fel egy futásban. A background function 15 percet kap;
// egy board = 1 lista-hívás + a HU-sorok detail-hívásai, tipikusan pár másodperc.
// Óránkénti futás mellett ez egyben a napi terhelés plafonja is: 16 futás × 20
// tenant = max 320 board-lekérés/nap, akkor is, ha a felderítő több száz
// tenantot hoz be. A `live` boardok mindig előre kerülnek a rendezésben, tehát
// a keretből ők nem szorulnak ki.
const BATCH_SIZE = Number(process.env.ATS_CRAWL_BATCH || 20);

// Újranézési ütem státusz szerint.
//
// A `live` boardokra NINCS időkorlát: 2026-08-26 óta ez a worker óránként fut
// (cron_scheduler.mjs :40, user-döntés — ugyanaz a tempó, mint a LinkedIn-é),
// és ezen a néhány boardon vannak a magyar hirdetések, tehát minden körben
// esedékesek. A tényleges plafon a BATCH_SIZE, nem egy időablak.
//
// A 0 magyar állást adó boardokat NEM dobjuk el (holnap nyithatnak budapesti
// pozíciót), csak ritkábban nézzük — ezek túlnyomó része a felderítőből jövő,
// szlug-egyezésen alapuló idegen cég, amit óránként lekérni tiszta pazarlás.
const RECHECK_NO_HU_DAYS = 3;

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

/* ── seed ─────────────────────────────────────────────────────────────
   2026-08-26-i kézi próbából (scratch-script, 64 cég × 4 provider). A lista
   MINDIG lefut, de addTenantIfNew (_ats_state.mjs) a meglévő kulcsokra
   tényleg semmit nem ír — nem csak "no-op update", hanem szó szerint nincs
   blob-írás, ha nincs új tenant. Ide felvenni új tenantot = deploy után
   magától bekerül, a meglévők könyvelése (last_checked, hit_count) érintetlen
   marad. Tenantot NE innen töröljünk kikapcsoláshoz — a törölt sor a
   következő deploynál visszajön; helyette status='dead'.

   2026-09-02: smartrecruiters/wise és smartrecruiters/rolandberger IDE KÖLTÖZTEK.
   Korábban a külön cron_jobs_ATS-background.mjs aratta "wise"/"roland" source
   alatt (két scraper egy hirdetésre = duplikáció, ezért maradtak eddig itt
   kihagyva) — a fájl megszűnt, a meglévő sorok source-a egyszeri migrációval
   át lett írva "ats-crawl"-ra, az `_ats_handoff.mjs` legacy-kivétele törölve. */
const SEED_TENANTS = [
  // SmartRecruiters — a régi cron_jobs_ATS-background.mjs örökösei (2026-09-02).
  // A cégazonosító a SmartRecruiters API-ban kis-nagybetű-tűrő (élőben mérve),
  // a slug itt ezért lowercase, konzisztensen a többi providerrel.
  { provider: "smartrecruiters", slug: "wise", company: "Wise" },
  { provider: "smartrecruiters", slug: "rolandberger", company: "RolandBerger" },
  // Van élő budapesti hirdetése (2026-08-26-i mérés)
  { provider: "greenhouse", slug: "wolt", company: "Wolt" },
  { provider: "ashby", slug: "shapr3d", company: "Shapr3D" },
  { provider: "ashby", slug: "craftdocs", company: "Craft" },
  { provider: "ashby", slug: "seon", company: "SEON" },
  // Létező board, jelenleg 0 magyar hirdetéssel — ritkább újranézésre
  { provider: "ashby", slug: "uipath", company: "UiPath" },
  { provider: "ashby", slug: "docplanner", company: "Docplanner" },
  { provider: "ashby", slug: "vantage", company: "Vantage" },
  { provider: "ashby", slug: "bumble", company: "Bumble" },
  { provider: "greenhouse", slug: "celonis", company: "Celonis" },
  { provider: "greenhouse", slug: "n26", company: "N26" },
  { provider: "greenhouse", slug: "typeform", company: "Typeform" },
  { provider: "greenhouse", slug: "cloudflare", company: "Cloudflare" },
  { provider: "greenhouse", slug: "datadog", company: "Datadog" },
  { provider: "greenhouse", slug: "diligent", company: "Diligent" },
  { provider: "greenhouse", slug: "gympass", company: "Wellhub" },
  { provider: "greenhouse", slug: "sumup", company: "SumUp" },
  { provider: "greenhouse", slug: "payoneer", company: "Payoneer" },
  { provider: "greenhouse", slug: "contentful", company: "Contentful" },
  { provider: "lever", slug: "nielsen", company: "Nielsen" },
  // Recruitee (2026-08-30, a provider felvételekor élőben igazolt): a
  // felderítő magától is megtalálná, de csak akkor, amikor a "blackbelt"
  // jelölt sorra kerül a több ezres újrapróbálási backlogban — ez a sor
  // ad neki azonnal egy bizonyítottan magyar hirdetéses recruitee-boardot.
  { provider: "recruitee", slug: "blackbelt", company: "BlackBelt Technology" },
  // Teamtailor (2026-09-01, a provider felvételekor élőben igazolt): a
  // felderítő magától is megtalálná, de ez ad neki azonnal egy bizonyítottan
  // magyar hirdetéses boardot, mielőtt a slug-jelöltek sorára kerülne.
  { provider: "teamtailor", slug: "kpmgglobalservices", company: "KPMG Global Services Hungary" },
  // Personio (2026-08-30): 76 magyar cég-slug lepróbálásából ez a két találat.
  // A teliogroup budapesti IT-hirdetéseket ad; a szallas ma Miskolc/Cluj, tehát
  // a helyszín-kapun elvérzik — mégis bent marad, mert holnap nyithat budapestit,
  // és a `no_hu` rotáció pont erre való.
  { provider: "personio", slug: "teliogroup", company: "Telio Group" },
  { provider: "personio", slug: "szallas", company: "Szállás Group Zrt." },

  /* Workday (2026-08-30). Ezek NEM tippek: mind a 23 tenant a saját
     `job_posts`-unkból származik — olyan myworkdayjobs.com url-ek hostjából és
     site-jából, amiket más forrásaink (zömmel AI-scraped) már behoztak, tehát
     bizonyítottan hirdetnek Budapesten. A workday nem tippelhető provider (a
     tenant+wdN+site hármas nem kitalálható), ezért a felderítő sem hozza be
     őket — ez a lista a belépőjük. A cégnév a hozzájuk tartozó job_posts
     sorokból van, nem slug-tippelésből.
     Slug-alak: "<tenant>.<wdN>:<site>" (ld. _ats_providers.mjs parseWorkdaySlug). */
  { provider: "workday", slug: "ms.wd5:External", company: "Morgan Stanley" },
  { provider: "workday", slug: "accenture.wd103:AccentureCareers", company: "Accenture" },
  { provider: "workday", slug: "mastercard.wd1:CorporateCareers", company: "Mastercard" },
  { provider: "workday", slug: "genesys.wd1:Genesys", company: "Genesys" },
  { provider: "workday", slug: "sanofi.wd3:SanofiCareers", company: "Sanofi" },
  { provider: "workday", slug: "genpact.wd108:External_Careers", company: "Genpact" },
  { provider: "workday", slug: "goto.wd5:GoToCareers", company: "GoTo" },
  { provider: "workday", slug: "silabs.wd1:SiliconlabsCareers", company: "Silicon Labs" },
  { provider: "workday", slug: "nngroup.wd3:WDExternal", company: "NN Group" },
  { provider: "workday", slug: "pwc.wd3:Global_Campus_Careers", company: "PwC Hungary" },
  { provider: "workday", slug: "dxctechnology.wd1:DXCJobs", company: "DXC Technology" },
  { provider: "workday", slug: "kyndryl.wd5:KyndrylProfessionalCareers", company: "Kyndryl" },
  { provider: "workday", slug: "transamerica.wd5:AegonGBSC", company: "Aegon Global Business Solutions Center" },
  { provider: "workday", slug: "takkt.wd3:TAKKT", company: "TAKKT Group" },
  { provider: "workday", slug: "peak6group.wd1:CapMan", company: "PEAK6" },
  { provider: "workday", slug: "nvidia.wd5:NVIDIAExternalCareerSite", company: "NVIDIA" },
  { provider: "workday", slug: "onehealthineers.wd3:SHSJB", company: "Siemens Healthineers" },
  { provider: "workday", slug: "gehc.wd5:GEHC_ExternalSite", company: "GE HealthCare" },
  { provider: "workday", slug: "jci.wd5:JCI", company: "Johnson Controls" },
  { provider: "workday", slug: "icon.wd3:broadbean_external", company: "ICON plc" },
  { provider: "workday", slug: "cognex.wd1:External_Career_Site", company: "Cognex" },
  { provider: "workday", slug: "greif.wd5:Greif", company: "Greif" },
  { provider: "workday", slug: "unisys.wd5:External", company: "Unisys" },
];

// 2026-09-03: ats_tenants Blobs-ra költözött (_ats_state.mjs) — az itt maradó
// egyetlen dolog a SEED_TENANTS lista alábbi felvétele, in-memory.
function seedTenants(tenants) {
  let added = 0;
  for (const t of SEED_TENANTS) {
    if (addTenantIfNew(tenants, t.provider, t.slug, { company: t.company, discoveredVia: "manual-probe-2026-08-26" })) {
      added += 1;
    }
  }
  return added;
}

/*
 * Esedékes tenantok. A rendezés ELSŐ kulcsa szándékosan a BIZONYÍTOTTAN jó
 * board: az F2 felderítő tetszőleges számú tenantot tud behozni, és azok
 * többsége `no_hu` lesz (idegen cégek, slug-egyezésből — lásd a felderítő
 * addTenant kommentjét). Puszta last_checked-rendezéssel egy nagy no_hu-tömeg
 * kiszorítaná a napi keretből azt a néhány boardot, amelyiken tényleg vannak
 * magyar hirdetések.
 *
 * ⚠️ 2026-08-30-ig a kulcs `(status = 'live')` volt, ami NEM ezt csinálta: az
 * újonnan felderített tenant is `live` alapértékkel jön be (a felderítő nem
 * állít státuszt), `last_checked IS NULL`-lal, tehát a rendezés a MÉG SOSEM
 * LÁTOTT boardokat sorolta a bizonyítottan magyar hirdetéses boardok ELÉ —
 * pont fordítva, mint ahogy a fenti bekezdés ígérte. Egy nagyobb felderítő-
 * adag (pl. az SR globális kereső ~30 tenantja) így órákra kiszoríthatta volna
 * a wolt/shapr3d/craftdocs/seon köröket. A `last_checked IS NOT NULL` feltétel
 * a "már lekértük ÉS akkor volt rajta magyar hirdetés" halmazt jelöli ki, mert
 * a nulla magyar sorral záruló futás `no_hu`-ra állítja a státuszt.
 * A még sosem látott tenantok így a második csoport ELEJÉRE kerülnek
 * (NULLS FIRST) — ELMÉLETBEN nem éheznek ki, csak nem tolakszanak előre.
 *
 * ⚠️ 2026-09-02, élőben igazolva: A GYAKORLATBAN teljesen kiéheznek, ha az
 * első csoport (checked live) mérete eléri/meghaladja a `limit`-et. A `LIMIT`
 * a rendezés SZERINT válogat, nem arányosan a két csoportból — ha az első
 * csoportban ≥ `limit` sor van, a második csoport (last_checked IS NULL vagy
 * esedékes no_hu) EGYETLEN sort sem kap, SOHA, mert az első csoport minden
 * futás után önmagát tölti újra (a lekért 20 tenant last_checked-je frissül,
 * a csoport mérete így stabilan a limit fölött marad). Ez pont bekövetkezett:
 * a `live` tenantok száma a felderítő miatt 180-ra nőtt (BATCH_SIZE=20), így
 * hetek óta ugyanaz a ~180 tenant körforog, a kézzel felvett "bizonyítottan
 * jó" jelöltek egy része (pl. personio/teliogroup, a workday-lista fele) meg
 * a felderítő teljes `no_hu`-utánpótlása egyszer sem futott le — ez adta a
 * "ma nem talált semmit" panaszt: nem a jó boardokon nincs új hirdetés, hanem
 * az ígéretes újak sosem jutnak sorra. Fix: a második csoportnak KÜLÖN, a
 * `limit`-en FELÜLI, nem elvehető keretet adunk — additív, nem csökkenti az
 * élő tenantok meglévő óránkénti recheck-gyakoriságát.
 */
// A fenti indoklás 2026-09-03 óta selectDueTenants-ban (_ats_state.mjs) él,
// pontosan ugyanezzel a kétlépcsős logikával, csak Object.values()+sort a
// két SQL SELECT helyett.
const NEVER_CHECKED_RESERVE = 10;

// jobs.smartrecruiters.com/{Company}/{id}-{slug} — a numerikus id ROTÁL, amikor
// a hirdetést frissítik, tehát önmagában nem lehet sor-identitás. Ugyanaz a
// minta, amit a cron_jobs_ATS-background.mjs használ.
function srVolatilePattern(url) {
  const m = String(url).match(/^(https:\/\/jobs\.smartrecruiters\.com\/[^/]+\/)\d+-(.+)$/);
  return m ? `^${escapeRegex(m[1])}\\d+-${escapeRegex(m[2])}$` : null;
}

async function crawlTenant(client, tenant, { filters, categories, dupeIndex, tenants }) {
  const provider = getProvider(tenant.provider);
  if (!provider) {
    applyTenantResult(tenants, tenant.provider, tenant.slug, { status: "dead", error: `unknown provider ${tenant.provider}` });
    return { skipped: true };
  }

  const label = `${tenant.provider}/${tenant.slug}`;
  let listing;
  try {
    listing = await provider.list(tenant.slug);
  } catch (err) {
    applyTenantResult(tenants, tenant.provider, tenant.slug, { error: err.message.slice(0, 300) });
    console.error(`[atscrawl] ${label} list failed: ${err.message}`);
    return { failed: true };
  }

  // Nemlétező board — csak ott hihető, ahol a provider tényleg 404-el
  // (smartrecruiters nem, ld. _ats_providers.mjs fejléc).
  if (listing.notFound && provider.detectsMissingTenant) {
    applyTenantResult(tenants, tenant.provider, tenant.slug, { status: "dead", huCount: 0, error: "board 404" });
    console.log(`[atscrawl] ${label} → DEAD (404)`);
    return { dead: true };
  }

  const boardJobs = listing.jobs || [];

  // 1) helyszín-kapu ELŐSZÖR — a nehéz mezőket (detail-fetch, technológia-
  //    kinyerés) csak a megmaradt sorokra építjük fel. Egy 451 állásos boardon
  //    (datadog) ez a különbség 451 detail-hívás és 0 között.
  const huJobs = [];
  for (const job of boardJobs) {
    if (rejectAtsLocation(job.location)) continue;
    huJobs.push(job);
  }

  console.log(`[atscrawl] ${label}: board=${boardJobs.length} hu=${huJobs.length}`);

  /* Cégnév a boardtól, ha a hirdetés nem hozza.
     A felderített tenantok `company`-ja SZÁNDÉKOSAN NULL (a slug nem azonosítja
     a céget — ld. cron_ats_discover addTenant), ashby és lever pedig a
     hirdetés-payloadban sem ad cégnevet → 2026-08-28-ig minden ilyen sor
     cégnév NÉLKÜL került be (18 élő sor). A board saját nyitóoldalának címe
     viszont a board tulajdonosának saját állítása magáról, nem a mi tippünk,
     tehát tényként írható. Tenantonként egyszer kérjük le (utána a DB-ből jön),
     és csak akkor, ha van mit felcímkézni vele. */
  if (!tenant.company && huJobs.length > 0 && typeof provider.companyName === "function") {
    try {
      const name = await provider.companyName(tenant.slug);
      if (name) {
        // `tenant` UGYANAZ az objektum-referencia, mint ami a `tenants` dict-ben
        // ül (selectDueTenants Object.values()-ból ad vissza, nem másolatot),
        // tehát ez a mutáció önmagában elég — a run végi egyetlen writeTenants
        // ezt is elviszi, külön írás nem kell.
        tenant.company = name;
        console.log(`[atscrawl] ${label} company resolved → "${name}"`);
      } else {
        console.log(`[atscrawl] ${label} company unresolved (board title gave nothing)`);
      }
    } catch (err) {
      console.error(`[atscrawl] ${label} company lookup failed: ${err.message}`);
    }
  }

  // 1.5) cross-source dupe-szűrés — a helyszín-kapu UTÁN (kevesebb sor), de a
  // detail-hívás ELŐTT (ld. a fájl fejlécét: DUPE_CHECK_SOURCES), hogy egy már
  // profession/talent/LinkedIn/startupjobs alatt meglévő pozíció ne kössön le
  // felesleges detail-kérést sem, ne csak insertet. Emiatt itt nincs
  // `technologies` (az csak a detail-oldalból jön) — az isCrossSourceDupe hívás
  // szándékosan csak cím+cég alapján dönt (2026-09-03: lásd
  // _cross_source_dupe.mjs — a technologies paraméter hiánya = régi, kulcs-only
  // viselkedés). NE told előre a detail-fetch-et csak azért, hogy ide is jusson
  // technologies — az pont azt a kérés-spórolást venné el, amiért ez a blokk itt
  // van a fetch előtt.
  let dedupedHuJobs = huJobs;
  if (dupeIndex) {
    dedupedHuJobs = [];
    for (const job of huJobs) {
      const company = job.company || tenant.company || null;
      if (isCrossSourceDupe(dupeIndex, company, job.title)) {
        console.log(`[atscrawl] ${label} SKIP cross-source dupe "${job.title}" @ ${company}`);
        continue;
      }
      dedupedHuJobs.push(job);
    }
    if (dedupedHuJobs.length !== huJobs.length) {
      console.log(`[atscrawl] ${label} cross-source dupes skipped: ${huJobs.length - dedupedHuJobs.length}`);
    }
  }

  // 2) a HU-sorok teljes felépítése (insert ELŐTT, egyetlen detail-hívással)
  const built = [];
  for (const job of dedupedHuJobs) {
    let html = job.descriptionHtml;
    let url = job.url;
    if (job.detailRef) {
      try {
        const detail = await provider.detail(job);
        if (typeof detail === "string" || detail === null) {
          html = detail ?? html;
        } else if (detail && typeof detail === "object") {
          html = detail.html ?? html;
          url = detail.url ?? url;
        }
      } catch (err) {
        console.error(`[atscrawl] ${label} detail failed "${job.title}": ${err.message}`);
      }
    }
    if (!url) {
      console.log(`[atscrawl] ${label} skip no-url: "${job.title}"`);
      continue;
    }
    built.push({
      title: job.title,
      url: normalizeUrl(url) || url,
      company: job.company || tenant.company || null,
      location: job.location,
      experience: (html ? extractBodyExperience(html) : null) || "-",
      technologies: html ? extractTechnologies(html) : null,
    });
  }

  // 3) rotáló-id migráció (csak SmartRecruiters) — a sor URL-je változik, de a
  //    hirdetés ugyanaz; migráció nélkül minden frissítés új sort szülne.
  if (tenant.provider === "smartrecruiters") {
    const currentUrls = built.map((b) => b.url);
    for (const row of built) {
      const pattern = srVolatilePattern(row.url);
      if (!pattern) continue;
      const migrated = await migrateVolatileUrl(client, ATS_SOURCE, row.url, pattern, currentUrls);
      if (migrated) console.log(`[atscrawl] ${label} MIGRATED url → ${row.url}`);
    }
  }

  /* 4) reconcile-scope. A teljes board url-listájából vezetjük le, nem a
        szűrt sorokból — így akkor is helyes marad az előtag, ha épp 0 magyar
        hirdetés van. SmartRecruiters kivétel: ott a lista-elem még nem ismeri a
        publikus url-t (az a detail applyUrl-je), tehát csak a felépített
        HU-sorokból tudunk előtagot képezni. */
  const scopeCandidates = (boardJobs.map((j) => j.url).filter(Boolean).length > 0)
    ? boardJobs.map((j) => j.url).filter(Boolean)
    : built.map((b) => b.url);
  /* Az alapértelmezett szabály (a slug az url-ben van, ld. deriveScopePrefix)
     nem minden providerre igaz: a workday-nél a tenantot a host ÉS a site
     együtt azonosítja, az útvonal első szegmense meg az "en-US". Az ilyen
     provider maga adja meg az előtagot — az egységesség-ellenőrzés (és így a
     fail-safe "inkább nem deaktiválunk" irány) ott is kötelező. */
  const scopePrefix = typeof provider.scopePrefix === "function"
    ? provider.scopePrefix(tenant.slug, scopeCandidates)
    : deriveScopePrefix(tenant.slug, scopeCandidates);

  // Teljes listázásnak CSAK akkor tekintjük, ha van egységes url-előtag ÉS a
  // board nem üres. Bármelyik hiánya → reactivate-only, a deaktiválást a napi
  // 404-sweep végzi el helyette.
  const fullListing = Boolean(scopePrefix) && boardJobs.length > 0;
  if (!fullListing) {
    console.log(`[atscrawl] ${label} reconcile: reactivate-only (scope=${scopePrefix ?? "n/a"}, board=${boardJobs.length})`);
  }

  const result = await ingestJobs(client, {
    source: ATS_SOURCE,
    jobs: built,
    fullListing,
    filters,
    categories,
    rejectLocation: rejectAtsLocation,
    scopePrefix,
  });

  // A nem-IT sorok (ingestJobs úgyis eldobta volna őket, ld. skippedNonIt) a
  // marketing_scraper hatókörére nézve még lehetnek relevánsak — ugyanazon a
  // board-lekérésen belül, második, olcsó kapu (csak a cím alapján dönt).
  const marketingCandidates = built.filter(
    (job) => !isItJob(job.title, categories) && isInScopeTitle(job.title)
  );

  console.log(
    `[atscrawl] ${label} → hu=${huJobs.length} built=${built.length} inserted=${result.inserted} ` +
    `nonIt=${result.skippedNonIt} filtered=${result.skippedSenior} marketing=${marketingCandidates.length} ` +
    `reconcile=${JSON.stringify(result.reconcile)}`
  );

  applyTenantResult(tenants, tenant.provider, tenant.slug, {
    status: huJobs.length > 0 ? "live" : "no_hu",
    huCount: huJobs.length,
    inserted: result.inserted,
    error: null,
  });

  return { huCount: huJobs.length, inserted: result.inserted, marketingCandidates };
}

const _runJob = withTimeout("cron_jobs_ATSCRAWL-background", async () => {
  const [filters, categories] = await Promise.all([loadFilters(), loadCategories()]);

  const client = await pool.connect();
  let checked = 0;
  let totalHu = 0;
  let totalInserted = 0;
  const marketingCandidates = [];
  // Egy olvasás, egy írás a teljes futásra — a korábbi Postgres-verzió
  // tenantonként írt + a seed-lista minden futásban újra próbálkozott
  // (2026-09-03 előtt: ~35 no-op INSERT óránként, örökre). A végi
  // writeTenants csak akkor fut, ha VALÓBAN történt változás.
  const tenants = await readTenants();
  const seeded = seedTenants(tenants);
  if (seeded) console.log(`[atscrawl] seeded ${seeded} new tenant(s)`);

  const dueList = selectDueTenants(tenants, {
    limit: BATCH_SIZE,
    reserveLimit: NEVER_CHECKED_RESERVE,
    recheckNoHuDays: RECHECK_NO_HU_DAYS,
  });
  console.log(`[atscrawl] due tenants: ${dueList.length}`);

  try {
    const dupeIndex = await loadCrossSourceDupeIndex(client, ATS_SOURCE, { onlySources: CROSS_SOURCE_DUPE_SOURCES });
    console.log(`[atscrawl] cross-source dupe index: ${dupeIndex.size} keys`);

    for (const tenant of dueList) {
      const r = await crawlTenant(client, tenant, { filters, categories, dupeIndex, tenants });
      checked += 1;
      totalHu += r.huCount ?? 0;
      totalInserted += r.inserted ?? 0;
      if (r.marketingCandidates?.length) marketingCandidates.push(...r.marketingCandidates);
    }

    console.log(`[atscrawl] DONE — tenants=${checked} hu_rows=${totalHu} inserted=${totalInserted}`);
  } finally {
    client.release();
  }

  if (seeded || dueList.length > 0) await writeTenants(tenants);

  // A DB-kapcsolat lezárása UTÁN — ez egy külső HTTP-hívás a testvérprojekt
  // felé, nem kell hozzá a pool-kliens, és a fail-soft hiba (ld. header) itt
  // sem érintheti a fenti IT-oldali munkát.
  if (marketingCandidates.length) {
    console.log(`[atscrawl] marketing hand-off: ${marketingCandidates.length} candidate(s)`);
    await postMarketingCandidates(marketingCandidates);
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
