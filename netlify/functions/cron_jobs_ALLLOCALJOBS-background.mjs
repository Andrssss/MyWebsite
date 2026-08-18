/*
  AllLocalJobs (hu.alllocaljobs.com) – IT/Budapest scraper

  Kutatási jegyzet: scripts/ALLLOCALJOBS_SCRAPE_RESEARCH.md (2026-07-09 élő próbák)

  Forrás: aggregátor (Jooble-szerű, Yii2/PHP). TÖBB slice UNIÓJA (2026-07-10,
  user-jelzés: a "QA Manual Engineer" a qa-engineer-budapest slice-ban él, az
  it-budapest full-text "It" keresés NEM matchel rá — a slice-ok kereső-nézetek,
  egyik sem superset, ezért unió kell, DIAK_3/otp-minta). SSR lista + AJAX lapozás
  slice-onként:

  ⚠️ 2026-07-20: a slice-slug NEM kategória, hanem CÍM-RE menő full-text keresés
  (élőben igazolva: az it-budapest 87 találatának mindegyike szó szerint "IT"-t
  visel a címében; a breadcrumb "It"-et keresési kifejezésként mutatja). Ezért egy
  állás csak akkor látszik, ha a címe tartalmazza a kitalált kulcsszót — a
  "Fullstack Vezető Fejlesztő - Logisztikai Platform"-ot MIND A 10 slice elvéti.
  Emiatt jött be a `budapest` BÖNGÉSZŐ-lista (nem keresés!) teljes bejárása: az a
  város minden állását adja, cím-szóhasználattól függetlenül → ez az egyetlen
  igazi superset ezen a site-on.

  ⚠️ A böngésző-lista MINDEN iparágat hoz (3 294 vs a slice-unió ~540), ezért az
  onnan JÖVŐ sorokra kötelező az `isItJob` IT-allowlist kapu — a `job_filters`
  (isSeniorLike) csak denylist, nem szűrne ki egy "Customer Service Agent"-et.
  A slice-ból jövő sorok kapu NÉLKÜL mennek tovább, mint eddig (a slice maga a
  kapu) — így a meglévő ingest-viselkedés bitre változatlan.

  ⚠️ Város: KIZÁRÓLAG a `/állások/budapest` böngésző-lista használható, a csupasz
  `/állások` SOHA — az országos (5 954, vidéki állásokkal). Ebben a scraperben
  NINCS helyszín-szűrés kódban: a Budapest-scope-ot végig az URL adja.

  ⚠️ `?interval=1` (mai állások) NEM használható itt: dátum-ablakos lista a
  reconcile-nak azt üzenné, hogy minden tegnapi állás eltűnt → tömeges téves
  deaktiválás. Ez a talent `&date=1` / minddiak `date: today` hibaosztály
  (CRON_JOBS_AUDIT.md), kétszer megégetett minta.
    1. GET /állások/<slice> → 20 kártya + searchHash (yii.search.register)
       + következő oldal env/page (yii.search.next) + session cookie
    2. GET /vacancy-search/next?hash=&e=&page=N
       (X-Requested-With: XMLHttpRequest KÖTELEZŐ, különben 400; cookie kell)
       → HTML fragment 20 kártyával + következő oldal yii.search.next-je
    3. Utolsó oldal: nincs yii.search.next (yii.search.extra van helyette) → stop.
       Túlkérés → HTTP 400.

  Detail oldal (/állás-<token>) CSAK cookie-t kezelő kliensnek él: cookie nélkül
  redirect → /állások?requested_vacancy_not_found=1. Böngészőnek (friss sessionnek
  is) működik, tehát a tárolt URL navigálható — de a detail-fetch itt session-nel megy,
  és a not-found redirect fetch-hibának számít.

  ⚠️ A 404-sweep szabályai közé NEM kerülhet be (se REDIRECT_DEAD, se banner):
  ÉLŐ állás is más path-ra redirectel cookie nélkül, tehát a redirect-szabály
  élő sorokat ölne. Deaktiválást kizárólag a reconcileActive végzi — DE nem
  puszta listából-hiányzásra: egy grace-en túli, listából kiesett sort a
  reconcile confirmDead-kapuja előbb SESSION-nel lekéri, és csak akkor deaktivál,
  ha az a saját urljén requested_vacancy_not_found-ra redirectel. Így a lapozó-
  unió tűréséből (90%) kicsúszó, de ÉLŐ sorok nem esnek ki tévesen.

  ⚠️ 2026-07-30 (user-jelzés, élő 294-soros ellenőrzéssel megerősítve): a site
  KERESŐ-indexe ELMARAD az egyes hirdetések záródásától — egy már halott állás
  (saját urlje session-nel lekérve requested_vacancy_not_found-ra redirectel)
  simán TOVÁBBRA IS kártyaként szerepelhet a slice/böngésző-listákban, azaz a
  foundUrls-ben — ez 69/294 aktívnak jelölt sort érintett élőben mérve, tehát a
  fenti confirmDead-kapu (ami csak a listából-KIESETT sorokra fut) ezeket sosem
  éri el. Első nekifutásra egy soronkénti véletlen-mintás kiegészítést kapott ez
  a fájl (`reconcileActive`'s `confirmDeadExtraLimit`) — user-döntés alapján ez
  KIDOBVA (részleges/valószínűségi lefedés, nem garantált). A tényleges fix:
  külön napi teljes-lefedettségű sweep, lásd `cron_alllocaljobs_deepsweep-
  background.mjs` — MINDEN aktív alllocaljobs sort végigellenőriz session-nel,
  naponta egyszer (cron_dispatcher_daily triggereli, 14:00 UTC), nem csak egy
  random részhalmazt óránként. A session-fetch gépezet (makeJar/fetchWithSession/
  fixLocationEncoding) `_alllocaljobs_core.mjs`-be lett kiemelve, hogy a két
  fájl (ez + a deepsweep) ne két külön, idővel szétdriftelő másolatot tartson.

  ⚠️ 2026-08-18 (user-döntés, élő cég+title átfedés-vizsgálat után: 215 aktív
  sorból csak 23%-nak volt pontos cég+title egyezése talent/profession/
  LinkedIn-nel — NEM teljes duplikáció, de a valódi átfedést innentől kiszűrjük
  insertnél): ÚJ url-eknél, insert előtt, ha egy MÁS forrás AKTÍV sora ugyanarra
  a normalizált cég+title párra szól, a kártyát kihagyjuk (skippedDuplicateElsewhere).
  Csak aktív külső sorral hasonlítunk — egy régen lezárt, véletlen egyező cég+title
  ne nyeljen el egy ma is élő hirdetést. Meglévő (insert előtti) alllocaljobs
  duplikátumokat ez a run nem törli — arra lásd a retroaktív SQL takarítást.
*/

import { Pool } from "pg";
import { load as cheerioLoad } from "cheerio";
import { loadFilters } from "./load_filters.mjs";
import { loadCategories } from "./load_categories.mjs";
import { logFetchError, withTimeout } from "./_error-logger.mjs";
import { reconcileActive } from "./_active_core.mjs";
import { isItJob } from "./_ai_ingest_core.mjs";
import { isBlockedCompany } from "./_company_blocklist.mjs";
import { BASE, makeJar, fetchWithSession } from "./_alllocaljobs_core.mjs";
import {
  isInternshipTitle, isJuniorTitle, isMidLevelTitle,
  extractBodyExperience, extractTechnologies, ensureTechnologiesColumn,
  isSeniorExperience,
} from "./_experience_core.mjs";

let _filters = [];
let _categories = [];

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

// Kereső-szeletek uniója (darabszámok 2026-07-10-én). Egy állás több slice-ban
// is felbukkanhat (url-dedupe kezeli); a gyakornok/junior slice nem-IT sorait a
// blacklist szűri ki insertnél, a foundUrls-ben viszont benne maradnak (F3-safe).
const SLICE_SLUGS = [
  "it-budapest", // ~91
  "developer-budapest", // ~142
  "software-engineer-budapest", // ~88
  "devops-budapest", // ~66
  "qa-engineer-budapest", // ~11
  "frontend-budapest", // ~7
  "backend-budapest", // ~3
  "tesztelo-budapest", // most 0, magyar tesztelő-címeknek
  "gyakornok-budapest", // ~76, nem-IT-t a blacklist szűri
  "junior-budapest", // ~75, ugyanígy
];
const sliceUrl = (slug) => `${BASE}/%C3%A1ll%C3%A1sok/${slug}`;

// Város-BÖNGÉSZŐ lista (nem keresés) — a site egyetlen igazi superset-nézete.
// Slug KÖTÖTT: "budapest". Ide SOHA nem jöhet a csupasz "/állások" (országos).
const BROWSE_SLUG = "budapest";
const browseUrl = () => `${BASE}/%C3%A1ll%C3%A1sok/${BROWSE_SLUG}`;

// 20 kártya/oldal; a legnagyobb slice (developer, ~142) ≈ 8 oldal. A cap
// parser-hiba elleni védelem — ha elérjük, a walk NEM teljes (complete=false),
// hogy ne deaktiváljon tévesen.
const MAX_LIST_PAGES = 15;

// A böngésző-lista 2026-07-20-án 3 294 állás ≈ 165 oldal — külön, bőven fölé
// méretezett cap. Kimerülés = NEM természetes vég → complete=false (wherewework
// 07-11 tanulság: a cap-kimerülés guard nélkül ölt 15 élő sort).
const BROWSE_MAX_PAGES = 250;

// A detail-fetch (szint + technológiák) csak új url-eknél fut, és ha az
// időkeret közben lejár, az adott sor véglegesen '-'/technologies nélkül megy
// be — insert-only szabály miatt (LinkedInen kívül sehol nincs utólagos
// UPDATE) nincs későbbi gyógyulás. Ezért időkeret-túllépéskor a detail-fetch-et
// elhagyjuk, NEM a futást szakítjuk meg — a completeness (és így a reconcile)
// érintetlen.
// A withTimeout kerete háttérfüggvényre 14 perc; 10 percnél elzárjuk a csapot,
// hogy az upsertek + reconcile biztosan beférjenek.
const DETAIL_DEADLINE_MS = 10 * 60 * 1000;

// A reconcile confirmDead-kapuja a scrape UTÁN fut, soronként egy session-
// fetch-csel (+500ms). 12,5 percnél elzárjuk, hogy a végső UPDATE + release
// beférjen a 14 percbe; a határon túli jelöltek megerősítetlenül AKTÍVAK
// maradnak (fail-safe), a következő futás úgyis újra megnézi őket.
const CONFIRM_DEADLINE_MS = 12.5 * 60 * 1000;

/* ── helpers ─────────────────────────────────────────────────── */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizeWhitespace(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

function normalizeText(s) {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// Az á-s path percent-encoded kanonikus formára hozva — ez a tárolt url,
// erre megy a detail-fetch és ezt kapja a reconcile is.
function normalizeUrl(raw) {
  try {
    const u = new URL(raw);
    u.hash = "";
    ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid"]
      .forEach((p) => u.searchParams.delete(p));
    return u.toString().replace(/\?$/, "");
  } catch {
    return raw;
  }
}

function _blacklistRegex(k) {
  const escaped = normalizeText(k).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i");
}

function isSeniorLike(title) {
  const n = normalizeText(title);
  return _filters.some((k) => _blacklistRegex(k).test(n));
}

// Cross-source duplicate check (2026-08-18, user-döntés): ha egy másik forrás
// AKTÍV sora ugyanarra a cég+title párra szól, az AllLocalJobs-kártyát nem
// mentjük el — az aggregátor sokszor ugyanazt a hirdetést hordozza, amit
// talent/profession/LinkedIn/stb. már úgyis felszed. Csak AKTÍV külső sorokkal
// hasonlítunk (ha ott már lezárt, egy régi, más állásra illő cég+title
// véletlen egyezés ne nyeljen el egy ma is élő AllLocalJobs hirdetést).
function normalizeForDedupe(s) {
  return normalizeText(s).replace(/[^a-z0-9]+/g, " ").trim();
}
function dedupeKey(company, title) {
  return `${normalizeForDedupe(company)}|${normalizeForDedupe(title)}`;
}
/* ── extraction ─────────────────────────────────────────────── */

// A detail-oldal alján egy "Hasonló munkák, amelyeket még nem látott:" szekció ül,
// tele MÁS állások teljes szövegével (a valós oldal ~2/3-a!). Ha a nyers body-t adnánk
// az experience/technologies kinyerőknek, azok a szomszéd hirdetések kulcsszavait és
// év-számait is beszednék (megfigyelt szennyezés: egy Laravel/React + "3 év" hirdetés
// "Python, AWS, Azure, LLM" + "10 év" címkéket kapott a hasonló-jobs blokkból).
// A hasonló-kártyák data-href-es elemek (a lista is így hivatkozik rájuk) — a törlésük
// eltünteti a más-állás-szöveget, a valódi leírást viszont érintetlenül hagyja (az nem
// data-href-es). A megmaradó puszta "Hasonló munkák…" fejléc-szöveg kulcsszó-mentes.
function stripSimilarJobs(html) {
  const $ = cheerioLoad(html);
  $("[data-href]").remove();
  return $.html();
}

function parseCards(html) {
  const $ = cheerioLoad(html);
  const items = [];
  $(".js-vacancy-snippet").each((_, el) => {
    const $c = $(el);
    const rawHref = $c.attr("data-href") || "";
    // csak valódi detail linkek (/állás-<token>) — a fejléc canonical linkje stb. kiesik
    if (!/^https:\/\/hu\.alllocaljobs\.com\/(állás|%C3%A1ll%C3%A1s)-[A-Za-z0-9]+$/.test(rawHref)) return;
    const url = normalizeUrl(rawHref);

    const title = normalizeWhitespace($c.find(".c-up-feed-item__title a").first().text());
    if (!title || title.length < 4) return;

    const company =
      normalizeWhitespace($c.find('i[data-ico="business"]').parent().next().text()) || null;

    items.push({
      url,
      title: title.slice(0, 300),
      company: company ? company.slice(0, 200) : null,
    });
  });
  return items;
}

// yii.search.register({...}) → searchHash string (a lista MINDEN oldala hordozza,
// az érték a kereséshez kötött és stabil)
function parseSearchHash(html) {
  const m = html.match(/yii\.search\.register\((\{[\s\S]*?\})\)/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]).searchHash || null;
  } catch {
    return null;
  }
}

// yii.search.next({...}) → {page, env} a KÖVETKEZŐ oldalhoz; az utolsó oldalon
// nincs (yii.search.extra van helyette) → null = természetes vége
function parseNextParams(html) {
  const m = html.match(/yii\.search\.next\((\{[\s\S]*?\})\)/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[1]);
    if (!o.page || !o.env) return null;
    return { page: o.page, env: o.env };
  } catch {
    return null;
  }
}

// "Talált állások: <b ...>93</b>" — teljesség-ellenőrzéshez
function parseTotalCount(html) {
  const m = html.match(/Talált állások:\s*<b[^>]*>([\d\s ]+)</);
  if (!m) return null;
  const n = parseInt(m[1].replace(/[\s ]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

/* ── db ──────────────────────────────────────────────────────── */

// Insert-only, kivétel nélkül (user-szabály, LinkedInen kívül sehol nincs
// utólagos UPDATE): a sor insert előtt épül fel teljesen, a konfliktus esetén
// a meglévő sor változatlan marad.
async function upsertJob(client, item) {
  await client.query(
    `INSERT INTO job_posts
      (source, title, url, experience, company, technologies, first_seen)
     VALUES ($1,$2,$3,$4,$5,$6,NOW())
     ON CONFLICT (source, url) DO NOTHING;`,
    ["alllocaljobs", item.title, item.url, item.experience ?? "-", item.company || null, item.technologies ?? null]
  );
}

/* ── main scrape ─────────────────────────────────────────────── */

// Egy slice teljes bejárása. complete csak akkor, ha a lapozás természetesen ért
// véget, hiba nélkül, ÉS a begyűjtött darabszám nagyjából kiadja a slice saját
// "Talált állások" összesítőjét — így egy csendben eltörő selector/lapozó nem
// tud mass-deactivate-et okozni (F1).
async function walkSlice(slug, jar, { listUrl = sliceUrl(slug), maxPages = MAX_LIST_PAGES } = {}) {
  const items = [];
  let naturalEnd = false;
  let totalCount = null;
  let searchHash = null;
  let next = null;

  // 1. oldal: SSR lista — cookie, hash, env innen jön
  try {
    const { body } = await fetchWithSession(listUrl, jar);
    searchHash = parseSearchHash(body);
    next = parseNextParams(body);
    totalCount = parseTotalCount(body);
    const cards = parseCards(body);
    console.log(`[alllocaljobs] ${slug} page 1: ${cards.length} cards (total=${totalCount ?? "?"}, hash=${searchHash ? "ok" : "MISSING"})`);
    items.push(...cards);
    if (!next) naturalEnd = true;
  } catch (err) {
    await logFetchError("cron_jobs_ALLLOCALJOBS-background", { url: listUrl, message: err.message });
    console.error(`[alllocaljobs] ${slug} page 1 failed: ${err.message}`);
    return { items, complete: false };
  }

  // további oldalak: AJAX fragmentek
  for (let guard = 2; guard <= maxPages && next && searchHash; guard++) {
    await sleep(500);
    const pageUrl =
      `${BASE}/vacancy-search/next?hash=${encodeURIComponent(searchHash)}` +
      `&e=${encodeURIComponent(next.env)}&page=${next.page}`;
    try {
      const { body } = await fetchWithSession(pageUrl, jar, {
        "X-Requested-With": "XMLHttpRequest",
        Referer: listUrl,
      });
      const cards = parseCards(body);
      console.log(`[alllocaljobs] ${slug} page ${next.page}: ${cards.length} cards`);
      items.push(...cards);
      next = parseNextParams(body);
      if (!next) naturalEnd = true;
    } catch (err) {
      await logFetchError("cron_jobs_ALLLOCALJOBS-background", { url: `${slug} vacancy-search/next page=${next.page}`, message: err.message });
      console.error(`[alllocaljobs] ${slug} page ${next.page} failed: ${err.message}`);
      return { items, complete: false };
    }
  }

  const complete =
    naturalEnd && (totalCount == null || items.length >= totalCount * 0.9);
  if (!complete) {
    console.warn(`[alllocaljobs] ${slug} INCOMPLETE — naturalEnd=${naturalEnd}, collected=${items.length}/${totalCount ?? "?"}`);
  }
  return { items, complete };
}

async function scrapeAlllocaljobs(client) {
  // A detail-időkeret a FUTÁS elejéhez kötött, nem a bejárás végéhez: a böngésző-
  // lista ~165 oldala önmagában percek, utána indítva a számlálót a kettő összege
  // átlépné a withTimeout 14 percét.
  const runStart = Date.now();

  const jar = makeJar();
  const seen = new Set();
  const allItems = [];
  const foundUrls = [];

  // Slice-ok uniója; BÁRMELYIK slice hibája → complete=false (DIAK_3
  // allSucceeded-minta), mert a hiányzó slice állásai tévesen deaktiválódnának.
  let allComplete = true;
  for (const slug of SLICE_SLUGS) {
    const { items, complete } = await walkSlice(slug, jar);
    allItems.push(...items);
    if (!complete) allComplete = false;
    await sleep(500);
  }

  // Böngésző-lista a slice-ok UTÁN: a `seen` dedupe így a slice-változatot tartja
  // meg, vagyis a slice-ból is látszó állások pontosan úgy mennek be, mint eddig
  // (nem esnek az isItJob kapu alá) — a bővítés tisztán additív.
  //
  // Hibája ugyanúgy complete=false, mint bármelyik slice-é: ha a 165 oldalas
  // bejárás félbeszakad, a nem látott urljei hiányoznának a foundUrls-ből és
  // tévesen deaktiválódnának. Konzervatív irány — inkább ne deaktiváljunk.
  const browse = await walkSlice(BROWSE_SLUG, jar, {
    listUrl: browseUrl(),
    maxPages: BROWSE_MAX_PAGES,
  });
  const browseItems = browse.items.map((i) => ({ ...i, fromBrowse: true }));
  allItems.push(...browseItems);
  if (!browse.complete) allComplete = false;
  console.log(`[alllocaljobs] browse ${BROWSE_SLUG}: ${browseItems.length} cards (complete=${browse.complete})`);

  if (allItems.length === 0) {
    console.error("[alllocaljobs] no cards from ANY slice OR the browse list — skipping upsert+reconcile");
    return;
  }

  // F3-védelem: a foundUrls a TELJES listát kapja (senior-/cégszűrés előtt!), hogy
  // egy blacklist-változás miatt kieső, de még élő állás ne deaktiválódjon.
  let newlyInserted = 0;
  let alreadyExisted = 0;
  let skippedSenior = 0;
  let skippedCompany = 0;
  let skippedNonIt = 0;
  let skippedDetailBudget = 0;
  let skippedDeadOnArrival = 0;
  let skippedDuplicateElsewhere = 0;
  const detailDeadline = runStart + DETAIL_DEADLINE_MS;

  // Detail-fetch KIZÁRÓLAG genuinely új url-eknél fut — egy már ismert sor
  // insert-only szabály miatt (LinkedInen kívül sehol nincs utólagos UPDATE)
  // úgysem gyógyulna, a fetch csak elpazarolt kérés lenne.
  const { rows: knownRows } = await client.query(
    `SELECT url FROM job_posts WHERE source = 'alllocaljobs'`
  );
  const known = new Set(knownRows.map((r) => r.url));

  const { rows: otherActiveRows } = await client.query(
    `SELECT company, title FROM job_posts
     WHERE source <> 'alllocaljobs' AND active = true AND company IS NOT NULL`
  );
  const otherActiveKeys = new Set(
    otherActiveRows.map((r) => dedupeKey(r.company, r.title))
  );

  for (const item of allItems) {
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    foundUrls.push(item.url);

    if (isSeniorLike(item.title)) {
      skippedSenior++;
      continue;
    }

    // IT-allowlist KIZÁRÓLAG a böngésző-listából jövő sorokra (lásd fejléc): az
    // minden iparágat hoz, a slice-ok viszont maguk IT-keresések. Ugyanaz a kapu,
    // amit az AI-pipeline használ (_ai_ingest_core.isItJob, job_categories).
    if (item.fromBrowse && !isItJob(item.title, _categories)) {
      skippedNonIt++;
      continue;
    }

    if (isBlockedCompany(item.company, "alllocaljobs")) {
      skippedCompany++;
      continue;
    }

    // Ismert url-eket nem dobjuk ki utólag (insert-only, lásd fejléc) — a
    // dedupe csak ÚJ soroknál dönt a mentésről, meglévő alllocaljobs sorokat
    // ez a run nem érinti (azokra lásd a visszamenőleges SQL takarítást).
    if (!known.has(item.url) && item.company &&
        otherActiveKeys.has(dedupeKey(item.company, item.title))) {
      skippedDuplicateElsewhere++;
      continue;
    }

    // A sor TELJESEN felépül insert ELŐTT (fetch-before-insert szabály): cím-rövidzár,
    // különben új url-nél detail-fetch a body-alapú szinthez + technológiákhoz.
    item.experience = isInternshipTitle(item.title) ? "diákmunka"
      : isJuniorTitle(item.title) ? "junior"
      : isMidLevelTitle(item.title) ? "medior"
      : "-";

    if (!known.has(item.url) && Date.now() >= detailDeadline) {
      // Időkeret elfogyott — '-'-szal / technologies nélkül megy be. A
      // completeness szándékosan NEM romlik ettől (lásd DETAIL_DEADLINE_MS).
      skippedDetailBudget++;
    } else if (!known.has(item.url)) {
      try {
        await sleep(500);
        const { body, finalUrl } = await fetchWithSession(item.url, jar);
        if (finalUrl.includes("requested_vacancy_not_found")) {
          // A kereső-index elmarad a hirdetés-záródástól (lásd fejléc, 2026-07-30):
          // egy kártya felbukkanhat egy már lezárt állásra is. Ha ez az ELSŐ
          // detail-fetchen derül ki (új url, insert előtt), a sort ki kell hagyni —
          // különben egy sosem-élt állás kerül be aktív sorként ('-'/null mezőkkel).
          skippedDeadOnArrival++;
          continue;
        }
        const detailBody = stripSimilarJobs(body); // a "Hasonló munkák" blokk nélkül
        // technologies KIZÁRÓLAG innen jön — mindig lefut, még akkor is, ha a
        // cím-rövidzár már megadta az experience-t (azt csak akkor írjuk felül,
        // ha még "-").
        if (item.experience === "-") item.experience = extractBodyExperience(detailBody) || "-";
        item.technologies = extractTechnologies(detailBody);
      } catch (err) {
        await logFetchError("cron_jobs_ALLLOCALJOBS-background", { url: item.url, message: `detail: ${err.message}` });
      }
    }

    if (isSeniorExperience(item.experience)) {
      skippedSenior++;
      continue;
    }

    if (known.has(item.url)) {
      alreadyExisted++;
    } else {
      newlyInserted++;
      console.log(`[alllocaljobs] NEW [${item.experience}] "${item.title}" (${item.company ?? "?"})`);
    }
    await upsertJob(client, item);
  }

  console.log(
    `[alllocaljobs] DONE — new=${newlyInserted}, existed=${alreadyExisted}, ` +
    `skipped_senior=${skippedSenior}, skipped_company=${skippedCompany}, ` +
    `skipped_nonit=${skippedNonIt}, skipped_detail_budget=${skippedDetailBudget}, ` +
    `skipped_dead_on_arrival=${skippedDeadOnArrival}, ` +
    `skipped_duplicate_elsewhere=${skippedDuplicateElsewhere}, ` +
    `unique=${foundUrls.length} (raw=${allItems.length}, complete=${allComplete})`
  );

  // confirmDead: a listából kiesett, grace-en túli sorokat a reconcile csak
  // akkor deaktiválja, ha a saját urljük SESSION-nel lekérve
  // requested_vacancy_not_found-ra redirectel (ugyanaz a halál-jel, amit a
  // detail-enrich is használ, lásd fentebb). Élő sor 200-zal betölt → false →
  // marad aktív. Hiba/keret-túllépés → false → marad aktív (fail-safe).
  const confirmDeadline = runStart + CONFIRM_DEADLINE_MS;
  const confirmDead = async (url) => {
    if (Date.now() >= confirmDeadline) return false;
    await sleep(500);
    try {
      const { finalUrl } = await fetchWithSession(url, jar);
      return finalUrl.includes("requested_vacancy_not_found");
    } catch {
      return false;
    }
  };

  const rc = await reconcileActive(client, "alllocaljobs", foundUrls, {
    complete: allComplete,
    confirmDead,
  });
  console.log(`[alllocaljobs] active reconcile — complete=${allComplete}, ${JSON.stringify(rc)}`);
}

/* ── handler ─────────────────────────────────────────────────── */

const _runJob = withTimeout("cron_jobs_ALLLOCALJOBS-background", async () => {
  [_filters, _categories] = await Promise.all([loadFilters(), loadCategories()]);
  const client = await pool.connect();
  try {
    await ensureTechnologiesColumn(client);
    await scrapeAlllocaljobs(client);
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
