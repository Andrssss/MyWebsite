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

async function dueCandidates(client, limit) {
  const { rows } = await client.query(
    `SELECT slug, source_company
       FROM ats_slug_candidates
      WHERE status = 'new'
         OR (status = 'error' AND probed_at < NOW() - make_interval(days => $2::int))
      ORDER BY probed_at ASC NULLS FIRST, created_at ASC
      LIMIT $1`,
    [limit, RETRY_ERROR_DAYS]
  );
  return rows;
}

async function recordCandidate(client, slug, status, hitProvider) {
  await client.query(
    `UPDATE ats_slug_candidates
        SET status = $2, hit_provider = $3, probed_at = NOW()
      WHERE slug = $1`,
    [slug, status, hitProvider ?? null]
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

const _runJob = withTimeout("cron_ats_discover-background", async () => {
  const client = await pool.connect();
  let probed = 0;
  let hits = 0;
  let newTenants = 0;
  let errors = 0;
  try {
    await ensureSchema(client);

    const intake = await intakeCandidates(client, CANDIDATE_INTAKE);
    console.log(`[atsdiscover] intake: ${intake.companies} new company name(s) → ${intake.added} candidate slug(s), ${intake.unusable} name(s) yielded none`);

    const candidates = await dueCandidates(client, PROBE_BUDGET);
    console.log(`[atsdiscover] probing ${candidates.length} candidate(s)`);

    for (const { slug, source_company: company } of candidates) {
      let outcome = "miss";
      let hitProvider = null;
      let sawError = false;

      for (const provider of PROBEABLE_PROVIDERS) {
        const r = await probeSlug(provider, slug);
        if (r === "hit") { outcome = "hit"; hitProvider = provider; break; }
        if (r === "error") sawError = true;
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
      await recordCandidate(client, slug, outcome, hitProvider);
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
