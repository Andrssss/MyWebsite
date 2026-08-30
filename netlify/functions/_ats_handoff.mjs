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

  ── Kivétel: amit már egy másik scraper arat ─────────────────────────────
  A `smartrecruiters/wise` és `smartrecruiters/rolandberger` boardokat a
  cron_jobs_ATS-background.mjs viszi `wise` / `roland` source alatt (SR_SOURCES),
  és a cron_jobs_ATSCRAWL seed-listája is szándékosan kihagyja őket.  Tenantként
  felvenni ugyanazt a duplikációt szülné, amit itt megszüntetünk — ezért ezeknél
  a sort eldobjuk (a másik forrás már hozza), tenantot viszont NEM veszünk fel.
  Ha az SR_SOURCES valaha bővül, ezt a listát is bővíteni kell.
*/

import { parseAtsUrl } from "./_ats_slug_core.mjs";

// "provider:slug" alakban — lásd a fejléc kivétel-szakaszát.
export const LEGACY_ATS_TENANTS = new Set([
  "smartrecruiters:wise",
  "smartrecruiters:rolandberger",
]);

/**
 * Mi legyen ezzel az url-lel az AI-ingest útján?
 *
 * @param {string} url
 * @returns {null | {kind:"legacy", provider:string, slug:string}
 *                 | {kind:"tenant", provider:string, slug:string}}
 *   null = nem ATS-url, menjen a szokásos úton.
 */
export function atsHandoff(url) {
  const parsed = parseAtsUrl(url);
  if (!parsed) return null;
  const key = `${parsed.provider}:${parsed.slug}`;
  return { kind: LEGACY_ATS_TENANTS.has(key) ? "legacy" : "tenant", ...parsed };
}

// Az `ats_tenants` táblát rendes körülmények között a cron_jobs_ATSCRAWL hozza
// létre; ha az AI-ingest fut előbb egy friss adatbázison, az átadás nem halhat
// el "reláció nem létezik" hibával — akkor ugyanis a sort már eldobtuk, a leadet
// meg elveszítenénk.  Ugyanaz a séma, mint az ats-tenants.mjs ensureSchema-jában.
let _tableReady = false;
export async function ensureAtsTenantTable(client) {
  if (_tableReady) return;
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
  _tableReady = true;
}

/**
 * Tenant felvétele egy AI-találat url-je alapján.  Nem probálunk: a hirdetés
 * url-je maga a bizonyíték, hogy a board létezik (ugyanez az elv, mint az
 * ats-tenants.mjs `fromUrl` ágán).
 *
 * A `company` szándékosan NULL marad — a beküldött nevet csak eredet-megjegyzés-
 * ként tároljuk a `discovered_via`-ban.  Indoklás az ats-tenants.mjs-ben: egy
 * hibás névből a board MINDEN hirdetésére hibás cégnév kerülne; a valódi nevet a
 * provider adja, ha tudja.
 *
 * @returns {Promise<boolean>} true, ha új sor keletkezett
 */
export async function registerAtsTenant(client, { provider, slug, company = null, via = "ai-handoff" }) {
  await ensureAtsTenantTable(client);
  const note = company ? `${via}:${String(company).slice(0, 150)}` : via;
  const res = await client.query(
    `INSERT INTO ats_tenants (provider, slug, company, discovered_via)
     VALUES ($1,$2,NULL,$3)
     ON CONFLICT (provider, slug) DO NOTHING`,
    [provider, slug, note]
  );
  return res.rowCount > 0;
}
