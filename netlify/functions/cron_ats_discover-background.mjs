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

const CANDIDATE_INTAKE = Number(process.env.ATS_DISCOVER_INTAKE || 300);
const PROBE_BUDGET = Number(process.env.ATS_DISCOVER_BUDGET || 45);
// Udvariassági szünet két jelölt között (a providerek publikus, ingyenes
// API-jai — nem akarunk sorozatban ezer kérést lőni rájuk).
const PROBE_GAP_MS = 150;
// Hálózati hibára (429/5xx/timeout) a jelölt nem "miss", csak elhalasztjuk.
const RETRY_ERROR_DAYS = 7;
// Amivel a 2026-08-30 ELŐTT lepróbált jelöltek `probed_providers`-e feltöltődik
// (a recruitee felvétele előtt ez a három volt a PROBEABLE_PROVIDERS). Nem
// PROBEABLE_PROVIDERS-ből származtatva: az a lista bővülni fog, ez a historikus
// tény pedig fix.
const LEGACY_PROBED_PROVIDERS = ["ashby", "greenhouse", "lever"];

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

let _schemaReady = false;

async function ensureSchema(client) {
  if (_schemaReady) return;
  await client.query(`
    CREATE TABLE IF NOT EXISTS ats_slug_candidates (
      slug            text PRIMARY KEY,
      source_company  text,
      status          text NOT NULL DEFAULT 'new',
      hit_provider    text,
      probed_at       timestamptz,
      created_at      timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_ats_candidates_status ON ats_slug_candidates (status, probed_at)`
  );
  /* Provideronkénti könyvelés (2026-08-30, a recruitee felvételekor).
     A `status` egyetlen szó az EGÉSZ jelöltre ("miss" = egyik provideren sem
     volt), ami addig elég, amíg a providerek listája nem bővül. A bővüléskor
     viszont pont a régi, "miss"-re állított jelölteket kellene megnézni az ÚJ
     provideren — a status alapján viszont azok soha többé nem kerülnének sorra,
     tehát a bővítés csak a jövőbeli új cégnevekre hatna, a meglévő ~2300
     lepróbált slugra (köztük az összes eddig ismert magyar cégnevünkre) nem. */
  await client.query(
    `ALTER TABLE ats_slug_candidates
       ADD COLUMN IF NOT EXISTS probed_providers text[] NOT NULL DEFAULT '{}'`
  );
  // Egyszeri visszamenőleges feltöltés: ami a bővítés ELŐTT már le volt
  // próbálva, azt a régi három provideren próbáltuk. A második futástól ez a
  // feltétel nem illeszkedik semmire (a probed_providers már nem üres).
  await client.query(
    `UPDATE ats_slug_candidates
        SET probed_providers = $1::text[]
      WHERE probed_at IS NOT NULL AND cardinality(probed_providers) = 0`,
    [LEGACY_PROBED_PROVIDERS]
  );
  // A "melyik cégnevet dolgoztuk már fel" könyvelése KÜLÖN tábla, nem az
  // ats_slug_candidates.source_company. Azért, mert több cégnév ugyanarra a
  // slugra vezet ("Telekom Kft." és "Magyar Telekom Nyrt." → `telekom`), és a
  // slug elsődleges kulcs: a másodikként érkező cégnév ON CONFLICT DO NOTHING
  // miatt SEMMILYEN sort nem hagyna maga után, tehát minden futásban újra
  // kiválasztódna, és örökre elfogyasztaná az intake-keretet.
  await client.query(`
    CREATE TABLE IF NOT EXISTS ats_seen_companies (
      company    text PRIMARY KEY,
      seen_at    timestamptz NOT NULL DEFAULT NOW(),
      slug_count integer NOT NULL DEFAULT 0
    )
  `);
  // Az ats_tenants táblát az ATSCRAWL worker hozza létre; ha ez a job futna
  // előbb, itt is meg kell lennie, különben a találatot nincs hova írni.
  await client.query(`
    CREATE TABLE IF NOT EXISTS ats_tenants (
      provider        text NOT NULL,
      slug            text NOT NULL,
      company         text,
      status          text NOT NULL DEFAULT 'live',
      last_checked    timestamptz,
      last_hu_count   integer NOT NULL DEFAULT 0,
      hit_count       integer NOT NULL DEFAULT 0,
      last_error      text,
      discovered_via  text,
      created_at      timestamptz NOT NULL DEFAULT NOW(),
      PRIMARY KEY (provider, slug)
    )
  `);
  _schemaReady = true;
}

/**
 * Új slug-jelöltek felvétele a job_posts cégneveiből.
 *
 * Minden feldolgozott cégnév bekerül az `ats_seen_companies`-be — akkor is, ha
 * nem született belőle egyetlen jelölt sem (csupa általános szó), és akkor is,
 * ha a jelöltjeit egy másik cégnév már felvette. Ez az egyetlen könyvelés, ami
 * garantálja, hogy a cégnév-lista ténylegesen körbeér.
 */
async function intakeCandidates(client, limit) {
  const { rows } = await client.query(
    `SELECT DISTINCT company
       FROM job_posts
      WHERE company IS NOT NULL
        AND length(trim(company)) > 2
        AND NOT EXISTS (
          SELECT 1 FROM ats_seen_companies s WHERE s.company = job_posts.company
        )
      ORDER BY company
      LIMIT $1`,
    [limit]
  );

  let added = 0;
  let unusable = 0;
  for (const { company } of rows) {
    const slugs = candidateSlugs(company);
    if (slugs.length === 0) unusable += 1;
    for (const slug of slugs) {
      const res = await client.query(
        `INSERT INTO ats_slug_candidates (slug, source_company)
         VALUES ($1, $2)
         ON CONFLICT (slug) DO NOTHING`,
        [slug, company]
      );
      added += res.rowCount ?? 0;
    }
    await client.query(
      `INSERT INTO ats_seen_companies (company, slug_count) VALUES ($1, $2)
       ON CONFLICT (company) DO NOTHING`,
      [company, slugs.length]
    );
  }
  return { companies: rows.length, added, unusable };
}

/*
 * Esedékes jelöltek. Három csoport, ebben a fontossági sorrendben:
 *   1. `new`   — még sosem próbált slug (ide esnek az új cégnevek is)
 *   2. `error` — hálózati hiba miatt eldöntetlen, RETRY_ERROR_DAYS után újra
 *   3. `miss`  — cáfolt, DE van olyan providerünk, amin még nem próbáltuk
 *                (provider-bővítés; ld. a probed_providers oszlop kommentjét)
 *
 * A rendezés első kulcsa azért a `new`, mert a 3. csoport egy több ezres
 * egyszeri backlog: nélküle egy frissen felvett cégnév napokig a sor végén
 * ülne. (Ugyanaz a kiéheztetési hibaosztály, mint az ATSCRAWL tenant-
 * rotációjánál.)
 */
async function dueCandidates(client, limit) {
  const { rows } = await client.query(
    `SELECT slug, source_company, probed_providers
       FROM ats_slug_candidates
      WHERE status = 'new'
         OR (status = 'error' AND probed_at < NOW() - make_interval(days => $2::int))
         OR (status = 'miss' AND NOT (probed_providers @> $3::text[]))
      ORDER BY (status = 'new') DESC, probed_at ASC NULLS FIRST, created_at ASC
      LIMIT $1`,
    [limit, RETRY_ERROR_DAYS, PROBEABLE_PROVIDERS]
  );
  return rows;
}

// `probedProviders` = a slugra EDDIG kipróbált providerek uniója (a hívó
// számolja ki, mert az előző értéket úgyis kézben tartja). A hit_provider
// COALESCE-szal íródik, hogy egy későbbi, más provideren futó kör ne törölje
// az eredeti találat provideret.
async function recordCandidate(client, slug, status, hitProvider, probedProviders) {
  await client.query(
    `UPDATE ats_slug_candidates
        SET status = $2,
            hit_provider = COALESCE($3, hit_provider),
            probed_at = NOW(),
            probed_providers = $4::text[]
      WHERE slug = $1`,
    [slug, status, hitProvider ?? null, probedProviders]
  );
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
async function addTenant(client, provider, slug, guessedCompany) {
  const res = await client.query(
    `INSERT INTO ats_tenants (provider, slug, company, discovered_via)
     VALUES ($1,$2,NULL,$3)
     ON CONFLICT (provider, slug) DO NOTHING`,
    [provider, slug, `company-probe:${String(guessedCompany ?? "").slice(0, 150)}`]
  );
  return (res.rowCount ?? 0) > 0;
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

async function discoverSmartRecruiters(client) {
  const tenants = await collectSrTenants();
  let added = 0;
  for (const [slug, company] of tenants) {
    // A slug az SR saját kanonikus alakja ("Hiflylabs"), és az API
    // kis-nagybetűre érzéketlen (élőben ellenőrizve: `Hiflylabs` és
    // `hiflylabs` ugyanazt a boardot adja), tehát a tárolt alak
    // megjelenítés kérdése, nem működésé.
    const res = await client.query(
      `INSERT INTO ats_tenants (provider, slug, company, discovered_via)
       VALUES ('smartrecruiters', $1, $2, 'sr-global-search')
       ON CONFLICT (provider, slug) DO NOTHING`,
      [slug, company]
    );
    if (res.rowCount) {
      added += 1;
      console.log(`[atsdiscover] SR tenant added: ${slug} ("${company ?? "?"}")`);
    }
  }
  return { seen: tenants.size, added };
}

const _runJob = withTimeout("cron_ats_discover-background", async () => {
  const client = await pool.connect();
  let probed = 0;
  let hits = 0;
  let newTenants = 0;
  let errors = 0;
  try {
    await ensureSchema(client);

    // 2. ág ELŐSZÖR: pár lekérés, és a legjobb hozamú (a tippelés hit-rate-je
    // ~18%, itt minden találat bizonyítottan magyar hirdetéses board).
    const sr = await discoverSmartRecruiters(client);
    console.log(`[atsdiscover] SR global search: ${sr.seen} HU tenant(s) seen, ${sr.added} new`);

    const intake = await intakeCandidates(client, CANDIDATE_INTAKE);
    console.log(`[atsdiscover] intake: ${intake.companies} new company name(s) → ${intake.added} candidate slug(s), ${intake.unusable} name(s) yielded none`);

    const candidates = await dueCandidates(client, PROBE_BUDGET);
    console.log(`[atsdiscover] probing ${candidates.length} candidate(s)`);

    for (const { slug, source_company: company, probed_providers: already } of candidates) {
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
        const added = await addTenant(client, hitProvider, slug, company);
        if (added) newTenants += 1;
        console.log(`[atsdiscover] HIT ${hitProvider}/${slug} (from "${company}")${added ? " → tenant added" : " (already tracked)"}`);
      } else if (outcome === "error") {
        errors += 1;
      }
      await recordCandidate(client, slug, outcome, hitProvider, tried);
      await sleep(PROBE_GAP_MS);
    }

    console.log(
      `[atsdiscover] DONE — probed=${probed} hits=${hits} new_tenants=${newTenants} errors=${errors}`
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
