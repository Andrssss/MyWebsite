/*
  Kereszt-forrás duplikátum-kapu az AI-felderítéshez.

  ── Miért ────────────────────────────────────────────────────────────────
  A `job_posts` sor-identitása `(source, url)`, tehát UGYANAZ az állás két
  forrásnév alatt KÉT sor — és az url-ek természetesen különböznek, hiszen az
  egyik a cég saját karrieroldala, a másik a profession.hu-s hirdetés.  Élő
  eset (2026-09-01): "BI elemző" / BKK Zrt. — a `Profession` forrás 08-24-én
  hozta be, az AI-rutin 09-01-én ugyanazt a hirdetést a BKK saját oldaláról
  megint beszúrta.  A boardon két egyforma kártya jelenik meg.

  Ez ugyanaz a szerep-szétválasztási hiba, amit az ATS-boardoknál a
  `_ats_handoff.mjs` old meg: az AI-rutin dolga a FELDERÍTÉS — olyan cégek
  megtalálása, amiket egyetlen scraper sem lát.  Amit egy meglévő forrás már
  behozott, azt nem kell másodszor is beszúrni.

  ── A szabály ────────────────────────────────────────────────────────────
  Egy AI-jelöltet eldobunk, ha van MÁS forrásból származó, még AKTÍV sor
  ugyanazzal a (cím, cég) párral.  Mindkét oldalt normalizáljuk (ékezet,
  kisbetű, írásjel, zárójeles kiegészítés, cégforma-toldalék), a cégnél a
  tartalmazás is elég ("BKK" ⊂ "BKK Budapesti Közlekedési Központ Zrt."), a
  CÍMNEK viszont pontosan egyeznie kell — az a fék, ami miatt ez nem tud
  véletlenül két különböző álláshirdetést összemosni.

  Szándékos korlátok:
   • Cég nélküli jelöltet nem vizsgálunk.  Puszta cím-egyezés ("Junior Java
     Developer") két különböző cégnél mindennapos, azon dedupelni hibás lenne.
   • Csak AKTÍV sorok blokkolnak.  Egy lejárt régi hirdetés nem akadálya
     annak, hogy a cég új kiírását behozzuk.
   • Csak az AI-forrás felé egyirányú: a rendes scraperek nem néznek egymásra,
     azok saját forrásuk teljes kínálatát viszik (a reconcile is arra épül).
*/

/** Ékezet/írásjel-független alak. */
function fold(s) {
  return String(s || "")
    .normalize("NFD").replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Cím: a zárójeles kiegészítés ("(Power BI)", "(m/f/d)") nem része az azonosságnak. */
export function normTitle(s) {
  return fold(String(s || "").replace(/\([^)]*\)/g, " "));
}

// Cégforma-toldalékok — ezek nélkül ugyanaz a cég ("BKK Zrt." ↔ "BKK").
const LEGAL_FORMS = new Set([
  "zrt", "nyrt", "kft", "bt", "kkt", "kht", "nonprofit", "ev", "zartkoruen", "mukodo",
  "reszvenytarsasag", "gmbh", "ag", "ltd", "limited", "llc", "inc", "plc", "sa", "srl",
  "bv", "nv", "oy", "ab", "as", "spa", "co",
]);

export function normCompany(s) {
  const words = fold(s).split(" ").filter((w) => w && !LEGAL_FORMS.has(w));
  return words.join(" ");
}

/** "bkk" ⊂ "bkk budapesti kozlekedesi kozpont" — de üres/túl rövid nem egyezhet. */
function companyMatches(a, b) {
  if (!a || !b || a.length < 3 || b.length < 3) return false;
  if (a === b) return true;
  return a.includes(b) || b.includes(a);
}

/**
 * Megnézi, mely jelöltek vannak MÁR benne a DB-ben egy másik forrás aktív soraként.
 *
 * @param {import("pg").PoolClient} client
 * @param {string} source   a hívó saját forrásneve (ezt kihagyjuk az összevetésből)
 * @param {Array<{url:string,title:string,company?:string|null}>} jobs
 * @returns {Promise<Map<string, {source:string, title:string, company:string, url:string}>>}
 *          url → az a meglévő sor, ami miatt eldobjuk
 */
export async function findCrossSourceDuplicates(client, source, jobs) {
  const hits = new Map();
  const candidates = (jobs || [])
    .filter((j) => j && j.url && j.title && j.company)
    .map((j) => ({ url: j.url, t: normTitle(j.title), c: normCompany(j.company) }))
    .filter((j) => j.t && j.c);
  if (candidates.length === 0) return hits;

  // Egyetlen lekérés az egész kötegre. Csak aktív, cégnévvel rendelkező, MÁS
  // forrásból származó sorok érdekelnek — a normalizálás JS-ben történik, mert
  // az ékezet-független összevetéshez a Postgres `unaccent` kiterjesztésére nem
  // támaszkodhatunk (nincs garantálva a Neon-adatbázison).
  const { rows } = await client.query(
    `SELECT source, title, company, url
       FROM job_posts
      WHERE active = TRUE
        AND source <> $1
        AND company IS NOT NULL AND btrim(company) <> ''`,
    [source]
  );

  // cím szerinti index, hogy ne legyen jelölt × sor négyzetes összevetés
  const byTitle = new Map();
  for (const r of rows) {
    const t = normTitle(r.title);
    if (!t) continue;
    if (!byTitle.has(t)) byTitle.set(t, []);
    byTitle.get(t).push({ ...r, c: normCompany(r.company) });
  }

  for (const cand of candidates) {
    const bucket = byTitle.get(cand.t);
    if (!bucket) continue;
    const match = bucket.find((r) => companyMatches(cand.c, r.c));
    if (match) {
      hits.set(cand.url, { source: match.source, title: match.title, company: match.company, url: match.url });
    }
  }
  return hits;
}
