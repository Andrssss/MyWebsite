// src/lib/categorize.mjs
//
// A cím → kategória besorolás. **Ez a fájl az `allasfigyelo` (pestidev.hu) repo
// `app/lib/categorize.ts`-ének 1-1 portja** — user-döntés 2026-09-01: a
// publikus oldal a referencia-implementáció, itt (board + statisztika) pontosan
// ugyanaz a szabálysor fut. Ha ott változik, ITT is át kell vezetni, és utána
// újra kell építeni a statisztikát (a `job_daily_categories` derivált adat).
//
// EGY fájl, KÉT fogyasztó: `src/JobWatcher.jsx` (admin board) és
// `netlify/functions/_stats_core.mjs` (napi cron + újraépítés). Korábban külön
// másolatok éltek és rendre szétcsúsztak; ezért nincs több másolat.
//
// Az egyetlen szándékos eltérés a v2-től a bemenet ALAKJA: ott
// `{name, keywords}[]`, itt `[name, keywords[]]` párok (a `load_categories.mjs`
// és a JobWatcher natív alakja). A szabályok sorrendje és tartalma bitre azonos.

/** A "semmire sem illeszkedett" halom neve (nem DB-kategória). */
export const UNCATEGORIZED = "Egyéb";

/**
 * Nem szakma, hanem gyűjtő-hirdetés — "Talent Pool", "Careers", "Gyakornoki
 * program". Ezek korábban szétszóródtak aszerint, hogy a cím maradéka mit
 * említett ("AI/Machine Learning/Computer Vision - Talent Pool" a Data / AI-ba
 * esett), ezért minden más szabály ELŐTT rövidre zárnak.
 */
export const TALENT_POOL = "Talent Pool";

/**
 * Végső tie-break, erős → gyenge. Csak akkor dönt, ha a categorize() konkrét
 * szabályai után is több jelölt maradt. A listán kívüli kategória a
 * leggyengébb. A Talent Pool csak a teljesség kedvéért szerepel — a 0. szabály
 * jóval a tie-break előtt visszatér vele.
 */
export const CATEGORY_PRIORITY = [
  TALENT_POOL,
  "DevOps",
  "Security",
  "Data / AI",
  "Elemző / Analyst",
  "QA / Tesztelő",
  "Mobil",
  "Menedzser / PM",
  "UX/UI Design",
  "Webfejlesztés",
  "Hardware",
  "Mérnöki / Gyártás",
  "Hálózat / Infra",
  "Fejlesztő",
];

/** A gyűjtő-kategória DB-beli neve — bármi konkrétabb megveri. */
export const FALLBACK_CATEGORY = "Fejlesztő";

const rank = (c) => {
  const i = CATEGORY_PRIORITY.indexOf(c);
  return i === -1 ? CATEGORY_PRIORITY.length : i;
};

/**
 * A `~` előtaggal tárolt kulcsszó SZÓTŐ: a szón belül bárhol illeszkedik,
 * nem szóhatáron.
 *
 * A magyar ragoz és összetesz, ezért az alábbi szóhatáros alak nem látja a
 * `fejlesztő`-t az `Algoritmusfejlesztő`-ben vagy a `C# fejlesztőt keresünk`-ben.
 * A kulcsszó-tábla korábban összetételenként egy kézzel írt változattal nőtt
 * (`webfejlesztő`, `robotfejlesztő`, `szoftverfejlesztő`, `fejlesztőmérnök`, …)
 * és így is kihagyta a többségét. Egyetlen `~fejleszt` tő kiváltja az egészet.
 *
 * CSAK hosszú magyar tövekhez. Angol vagy rövid tő túl sokat fog: a
 * `~security` bekapná a "global securities services"-t is.
 */
export const STEM_PREFIX = "~";

/** Szóhatáros illesztés. */
export const kwRegex = (kw) =>
  new RegExp(
    `(^|[^a-z0-9])${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`,
    "i"
  );

// Kulcsszavanként-hirdetésenként regexet fordítani egy teljes listán ~5M
// allokáció lenne.
const regexCache = new Map();
const cachedRegex = (kw) => {
  let re = regexCache.get(kw);
  if (!re) {
    re = kwRegex(kw);
    regexCache.set(kw, re);
  }
  return re;
};

/** `lower` már kisbetűs — ez kulcsszavanként fut le címenként. */
const matchesKeyword = (kw, lower) => {
  const k = String(kw).toLowerCase();
  return k.startsWith(STEM_PREFIX) ? lower.includes(k.slice(1)) : cachedRegex(k).test(lower);
};

/**
 * Egy hirdetés PONTOSAN EGY kategóriába kerül, kizárólag a CÍM alapján — soha
 * nem a cégből vagy a leírásból. Az alábbi szabály-sorrend teherhordó: bármely
 * két lépés felcserélése több száz hirdetést sorol át némán.
 *
 * @param {string} title
 * @param {Array<[string, string[]]>} categories  [name, keywords] párok
 * @returns {string} pontosan egy kategórianév (vagy UNCATEGORIZED)
 */
export function categorize(title, categories) {
  if (!title || !categories || categories.length === 0) return UNCATEGORIZED;
  const lower = title.toLowerCase();

  // Előre gyűjtve, nem az alábbi felülbírálások után, mert a 0. és az 1.
  // szabálynak is tudnia kell, mi mást fogott meg a cím.
  const matches = categories
    .filter(([, keywords]) => (keywords || []).some((kw) => matchesKeyword(kw, lower)))
    .map(([name]) => name);

  // 0. szabály — a talent pool akkor is talent pool, ha mást hirdet.
  if (matches.includes(TALENT_POOL)) return TALENT_POOL;

  // 1. szabály — az analyst az analyst, KIVÉVE ha a cím security- vagy
  // teszt-szakosodást is megnevez: a "SOC Analyst", az "Information Security
  // Analyst" és a "Quality Analyst" azokra a polcokra való, nem az üzleti
  // elemzők közé. Az `elemz` tőre illeszt, hogy az `adatelemzo` (ékezet
  // nélkül) és az `Adatelemzési` is számítson.
  if (lower.includes("analyst") || lower.includes("elemz")) {
    if (matches.includes("Security")) return "Security";
    if (matches.includes("QA / Tesztelő")) return "QA / Tesztelő";
    return "Elemző / Analyst";
  }

  // 2. szabály — önálló "AI" token (nem az "Ai" a "maintain"-en belül).
  if (/(^|[^a-z0-9])ai([^a-z0-9]|$)/i.test(title)) return "Data / AI";

  if (matches.length === 0) return UNCATEGORIZED;
  if (matches.length === 1) return matches[0];

  // 3. szabály — a DevOps mindenki mást megver.
  if (matches.includes("DevOps")) return "DevOps";

  // A "Fejlesztő" a gyűjtő-fallback: bármi konkrétabb megveri.
  const withoutFallback = matches.filter((c) => c !== FALLBACK_CATEGORY);
  let effective = withoutFallback.length > 0 ? withoutFallback : matches;

  // Ez a kettő gyenge, de a fallbacknél még mindig erősebb.
  if (effective.length > 1 && effective.includes("Hálózat / Infra")) {
    effective = effective.filter((c) => c !== "Hálózat / Infra");
  }
  if (effective.length > 1 && effective.includes("Mérnöki / Gyártás")) {
    effective = effective.filter((c) => c !== "Mérnöki / Gyártás");
  }

  if (effective.length === 1) return effective[0];
  return [...effective].sort((a, b) => rank(a) - rank(b))[0] ?? UNCATEGORIZED;
}

/**
 * A régi tömb-alakú hívási felület a JobWatcher call site-jainak: üres tömb =
 * "nem kategorizált", egyébként pontosan egy elem. (A v2-ben nincs ilyen — ott
 * mindenhol a sima string-et használják.)
 */
export function getCategoriesForJob(job, jobCategories) {
  const cat = categorize(job?.title || "", jobCategories);
  return cat === UNCATEGORIZED ? [] : [cat];
}
