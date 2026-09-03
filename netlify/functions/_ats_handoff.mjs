/*
  AI-találat → ATS-tenant átadás.  Ez a fájl az EGYETLEN helye annak a
  szabálynak, hogy az AI-forrás nem ingestel ATS-hosztolt hirdetést.

  ── Miért ────────────────────────────────────────────────────────────────
  2026-08-30-i mérés a prod adatbázison: az `AI-scraped` 805 sorából 168 volt
  ATS-hosztolt url (greenhouse 47, smartrecruiters 45, ashby 44, lever 28,
  recruitee 4), 51 tenant mögött — és ebből 25 tenant nem is szerepelt az
  `ats_tenants` táblában.  Ugyanezeket a hirdetéseket az `ats-crawl` forrás is
  behozza, a `job_posts` sor-identitása viszont `(source, url)`, tehát ugyanaz
  az url két forrásnév alatt KÉT sor.  A teljes adatbázisban 59 bitre azonos
  url-duplikátum-csoport volt, ebből 55 pontosan ez a pár.

  Az időzítés is egyértelmű volt: az ats-crawl 46 közös hirdetésből 0-szor ért
  oda elsőként az AI-scraped előtt.  Vagyis nem gyorsaságban különböznek — a két
  forrás egyszerűen ugyanazt a munkát végzi.

  ── A megoldás nem dedup, hanem szerep-szétválasztás ─────────────────────
  Az AI-rutin FELDERÍT, az ats-crawl ARAT.  Ha egy AI-találat url-je
  felismerhető ATS-board url, akkor a sort nem szúrjuk be, hanem a mögötte lévő
  tenantot vesszük fel — onnantól az ats-crawl hozza az EGÉSZ boardot, nem csak
  azt az egy hirdetést, amit az LLM történetesen meglátott.  A fedés így nő, nem
  csökken (25 addig ismeretlen board teljes kínálata).

  Amit cserébe vállalunk: az ats-crawl helyszín-kapuja fail-closed
  (`_ats_location.mjs` — hiányzó helyszín = külföldi), az AI-rutiné pedig
  megengedőbb (kétes = marad).  Egy helyszín nélküli ATS-sor, amit az AI
  beengedett volna, így kimaradhat.  Tudatos csere; a visszaadott
  `handedToAtsUrls` lista teszi utólag mérhetővé, mi ment át ezen az úton.

  ── A korábbi kivétel megszűnt (2026-09-02) ──────────────────────────────
  A `smartrecruiters/wise` és `smartrecruiters/rolandberger` boardokat eddig a
  külön cron_jobs_ATS-background.mjs arata "wise"/"roland" source alatt, ezért
  itt tenantként felvenni duplikációt szült volna. Az a fájl megszűnt, a két
  board most rendes ats-crawl tenant (lásd cron_jobs_ATSCRAWL-background.mjs
  SEED_TENANTS) — tehát minden ATS-url ugyanazon az úton megy, kivétel nélkül.

  ── 2026-09-03: ats_tenants Blobs-ra költözött ────────────────────────────
  Ez a fájl a Postgres-klienst már nem használja — a tenant-felvétel a
  _ats_state.mjs blob-store-ján fut. A hívó (_ai_ingest_core.mjs) egy
  ingestJobs-futáson belül összegyűjti az ÖSSZES handoff-jelöltet, és EGYBEN
  adja át (registerAtsTenants), hogy egy futás legfeljebb egy blob-olvasás +
  egy blob-írás legyen, ne tenantonként egy.
*/

import { parseAtsUrl } from "./_ats_slug_core.mjs";
import { readTenants, writeTenants, addTenantIfNew } from "./_ats_state.mjs";

/**
 * Mi legyen ezzel az url-lel az AI-ingest útján?
 *
 * @param {string} url
 * @returns {null | {kind:"tenant", provider:string, slug:string}}
 *   null = nem ATS-url, menjen a szokásos úton.
 */
export function atsHandoff(url) {
  const parsed = parseAtsUrl(url);
  if (!parsed) return null;
  return { kind: "tenant", ...parsed };
}

/**
 * Tenant-felvétel egy köteg AI-találat url-je alapján. Nem probálunk: a
 * hirdetés url-je maga a bizonyíték, hogy a board létezik (ugyanez az elv,
 * mint az ats-tenants.mjs `fromUrl` ágán).
 *
 * A `company` szándékosan NULL marad — a beküldött nevet csak eredet-megjegyzés-
 * ként tároljuk a `discoveredVia`-ban. Indoklás az ats-tenants.mjs-ben: egy
 * hibás névből a board MINDEN hirdetésére hibás cégnév kerülne; a valódi nevet a
 * provider adja, ha tudja.
 *
 * @param {Array<{provider:string, slug:string, company?:string|null, via?:string}>} entries
 * @returns {Promise<string[]>} az ÚJONNAN felvett "<provider>:<slug>" kulcsok
 */
export async function registerAtsTenants(entries) {
  if (!entries?.length) return [];
  const tenants = await readTenants();
  const added = [];
  for (const { provider, slug, company = null, via = "ai-handoff" } of entries) {
    const discoveredVia = company ? `${via}:${String(company).slice(0, 150)}` : via;
    if (addTenantIfNew(tenants, provider, slug, { discoveredVia })) {
      added.push(`${provider}:${slug}`);
    }
  }
  if (added.length > 0) await writeTenants(tenants);
  return added;
}
