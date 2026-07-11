/*
  Cég-blocklist (user-döntés 2026-07-10/11): ezeknek a cégeknek a hirdetéseit
  az ide bekötött források nem mentik, a korábban bekerült soraikat a run eleji
  purge törli. Normalizált (ékezet-/kisbetű-független) PONTOS cégnév-egyezés —
  szándékosan nem substring, nehogy pl. egy "Bosch Rexroth"-ot vagy a
  "best-speed kft. - magyar telekom hivatalos partnere"-t is elkapja.

  A listák FORRÁSONKÉNT külön élnek (LISTS_BY_SOURCE), mert ugyanaz a cég
  forrásonként más-más néven hirdet (LinkedIn: "deutsche telekom" /
  "bosch magyarorszag"; talent/alllocaljobs: "Deutsche Telekom IT Solutions HU"
  / "Bosch Group") — egy közös lista vagy nem matchelne, vagy substringre
  kényszerülne.
*/

// talent + alllocaljobs + allasportal — a cégnév display-formában tárolódik.
// A "…IT Solutions" és az "…IT Solutions HU" két külön cégnév, ezért
// mindkettő listaelem.
export const COMPANY_BLOCKLIST = [
  "Deutsche Telekom IT Solutions HU",
  "Deutsche Telekom IT Solutions",
  "Magyar Telekom Nyrt.",
  "Bosch Group",
  "Siemens Energy",
  "MOL Magyarország",
];

// LinkedIn (user-döntés 2026-07-11) — a LinkedIn-scraper a cégnevet már
// normalizálva (lowercase, ékezet nélkül) tárolja, a lista ezt a formát követi.
export const LINKEDIN_COMPANY_BLOCKLIST = [
  "deutsche telekom it solutions hu",
  "telekom hu",
  "deutsche telekom",
];

const LISTS_BY_SOURCE = {
  talent: COMPANY_BLOCKLIST,
  alllocaljobs: COMPANY_BLOCKLIST,
  allasportal: COMPANY_BLOCKLIST,
  LinkedIn: LINKEDIN_COMPANY_BLOCKLIST,
};

function normalizeText(s) {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const _setsBySource = new Map(
  Object.entries(LISTS_BY_SOURCE).map(([src, list]) => [src, new Set(list.map(normalizeText))])
);

export function isBlockedCompany(company, source) {
  const set = _setsBySource.get(source);
  return !!set && company != null && set.has(normalizeText(company));
}

// Idempotens takarítás — az egyszeri kézi törlések (2026-07-10/11) után azt
// fedi le, ha a blocklist előtti deployolt kód még visszainsertelt párat,
// vagy ha a lista később bővül.
export async function purgeBlockedCompanies(client, source) {
  const list = LISTS_BY_SOURCE[source];
  if (!list) return 0;
  const { rowCount } = await client.query(
    `DELETE FROM job_posts
      WHERE source = $1 AND lower(company) = ANY($2::text[])`,
    [source, list.map((c) => c.toLowerCase())]
  );
  if (rowCount > 0) {
    console.log(`[${source}] company-blocklist purge: ${rowCount} sor törölve`);
  }
  return rowCount;
}
