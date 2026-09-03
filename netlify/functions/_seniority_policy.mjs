/*
 * Seniority-politika egy helyen (2026-08-25).
 *
 * A senior hirdetéseket MENTJÜK a job_posts-ba — a frontend dönti el, hogyan
 * mutatja: a JobWatcher alapból ELREJTI őket, a "Senior" kapcsoló pedig
 * KIZÁRÓLAG azokat mutatja. A rejtés egyetlen jele a `job_posts.experience`
 * oszlop ("senior"), mert a frontend ezt látja — ld. isSeniorExperience a
 * src/JobWatcher.jsx-ben és a _experience_core.mjs-ben.  Ezért MINDEN insert
 * előtt át kell futtatni a sort a seniorAwareExperience()-en, különben a
 * senior hirdetés jelöletlenül a normál listába kerül.
 *
 * A `job_filters` egy KÖZÖS, széles cím-denylist: van benne seniority-szó
 * (senior, lead, head…) ÉS rengeteg ettől független kizárás (support, SAP,
 * koordinátor, szakács…).  Csak a seniority-részhalmazt engedjük át; minden
 * más denylist-találat a régi módon kiszűri a hirdetést.
 *
 * A senior-felismerés NEM függ a job_filters tartalmától: a lenti lista
 * önálló. Így akkor is helyes marad, ha a seniority-szavakat kitöröljük a
 * job_filters táblából (akkor a denylist már nem is akad fönn rajtuk, a
 * címkézés viszont változatlanul működik).
 */
import { isSeniorExperience } from "./_experience_core.mjs";

export const STORE_SENIOR_JOBS = false; // 2026-09-04: ideiglenesen kikapcsolva, user-döntés

// CSAK a tiszta senior-jelzők (2026-08-25, user-döntés: "csak a senior, lead ne
// legyen, azokat még nem gyűjtjük"). A vezetői/lead címek — lead, leader,
// teamlead, head, chief, director, vp, vice president — ÉS a kétértelműek
// (manager, vezető, architect, expert, principal, staff) szándékosan NEM
// kerülnek ide: azok maradnak sima denylist-szavak, tehát a scraper továbbra is
// eldobja őket insert előtt. Ha egyszer kellenek, ide kell felvenni a szót ÉS
// törölni a job_filters-ből a párját.
export const SENIOR_TITLE_WORDS = [
  "senior",
  "szenior",
  "sr",        // "sr." is: a szóhatár-regex a pontot nem-alfanumerikusnak veszi
];

function normalizeFilterWord(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// A regexek fordítása drága: 1600+ job_filters szó × több száz cím / futás.
// Ugyanaz a minta, amit minden scraper _blacklistRegex-e használt (szóhatár
// a-z0-9 karakterekre), csak most cache-elve.
const _regexCache = new Map();
function filterRegex(word) {
  const key = normalizeFilterWord(word);
  let re = _regexCache.get(key);
  if (!re) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    re = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i");
    _regexCache.set(key, re);
  }
  return re;
}

const SENIOR_REGEXES = SENIOR_TITLE_WORDS.map(filterRegex);

/* ── senior-felismerés (job_filters-től függetlenül) ─────────────── */

export function isSeniorTitle(title) {
  const normalized = normalizeFilterWord(title);
  if (!normalized) return false;
  return SENIOR_REGEXES.some((re) => re.test(normalized));
}

// Egy job_filters szó akkor seniority-szó, ha maga is tartalmaz senior-jelzőt
// ("senior", "sr.", "VP,", "vp of engineering", "Head of Delivery" → igen).
export function isSeniorFilterWord(word) {
  return isSeniorTitle(word);
}

/* ── denylist ────────────────────────────────────────────────────── */

export function getFilterMatches(text, filters) {
  const normalized = normalizeFilterWord(text);
  if (!normalized) return [];
  const matches = [];
  for (const word of filters || []) {
    if (filterRegex(word).test(normalized)) matches.push(word);
  }
  return matches;
}

export function isSeniorTitleFilterMatch(title, filters) {
  return getFilterMatches(title, filters).some(isSeniorFilterWord);
}

export function shouldSkipTextFilter(text, filters) {
  const normalized = normalizeFilterWord(text);
  if (!normalized) return false;
  for (const word of filters || []) {
    if (!filterRegex(word).test(normalized)) continue;
    // Seniority-szó: nem dobjuk el, csak senior-ként címkézzük (lásd
    // seniorAwareExperience). Minden más denylist-találat kizár.
    if (!STORE_SENIOR_JOBS || !isSeniorFilterWord(word)) return true;
  }
  return false;
}

// Az ELSŐ olyan denylist-szó, ami tényleg kizárja a hirdetést (a seniority-
// szavakat átugorja) — naplózáshoz, hogy a log a valódi okot mutassa.
export function getBlockingFilterWord(text, filters) {
  const normalized = normalizeFilterWord(text);
  if (!normalized) return null;
  for (const word of filters || []) {
    if (!filterRegex(word).test(normalized)) continue;
    if (!STORE_SENIOR_JOBS || !isSeniorFilterWord(word)) return word;
  }
  return null;
}

export function shouldSkipTitleFilter(title, filters) {
  return shouldSkipTextFilter(title, filters);
}

/* ── címkézés (EZ teszi a frontend rejtését működővé) ────────────── */

// Insert előtt MINDEN forrásnál ezt kell az experience-re futtatni.
// A már senior-nak felismert értéket (taxonómia-szint, magas évszám) érintetlenül
// hagyja; a csak CÍMBŐL senior sort "senior"-ra írja, hogy a frontend elrejtse.
// A null/undefined értéket szándékosan ÉRINTETLENÜL adja vissza, hogy a hívó
// saját `?? "-"` / `|| null` utótagja változatlanul működjön.
export function seniorAwareExperience(title, experience) {
  if (!STORE_SENIOR_JOBS) return experience;
  if (isSeniorExperience(experience ?? "")) return experience;
  if (isSeniorTitle(title)) return "senior";
  return experience;
}

/* ── kill switch: STORE_SENIOR_JOBS=false esetén visszaáll a régi
      "insert előtt eldobjuk" viselkedés ──────────────────────────── */

export function shouldSkipSeniorExperience(isSenior) {
  return !STORE_SENIOR_JOBS && Boolean(isSenior);
}
