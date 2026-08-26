// netlify/functions/_stats_core.mjs
//
// A napi statisztika EGYETLEN közös magja: kategorizálás + nap-szintű
// összesítés. Eddig három, egymástól FÜGGETLENÜL szerkesztett másolat élt
// (src/JobWatcher.jsx, cron_daily_stats.mjs, backfill_daily_stats.mjs), és
// szét is csúsztak — a mentett statisztika ezért mást mutatott, mint a board:
//   - a két backend-másolat a RÉGI kategórianeveken számolt
//     ("Fejlesztő" / "Egyéb") a maiak helyett ("Egyéb fejlesztő" /
//     "Nem kategorizált") — a JobStats.jsx CATEGORY_DISPLAY_NAMES térképe
//     csak MEGJELENÍTÉSBEN foltozta ezt;
//   - a backfill prioritási listája még a törölt "C++" kategóriát tartalmazta,
//     az újabb "UX/UI Design"-t viszont nem;
//   - a frontend STRONG_CATEGORIES és "AI mint jelző" (ai-assisted) szabályai
//     egyik backend-másolatba sem jutottak el;
//   - a `*`-os kulcsszó-szintaxis (kwRegex) is csak a frontendben létezett,
//     tehát egy "*fejleszt*" kulcsszó a statisztikában szó szerint,
//     csillagostul keresődött (= sosem talált);
//   - a backfill a senior hirdetéseket BELESZÁMOLTA, a napi cron viszont nem.
//
// Ezért: aki szerver oldalon kategorizál a statisztikához, ezt a fájlt
// használja. A frontend marad a referencia-implementáció — ha ott változik a
// szabály, ITT is át kell vezetni (és utána újraépíteni a statisztikát).

import { INTERNSHIP_KEYWORDS, INTERN_SOURCES, isSeniorExperience } from "./_experience_core.mjs";

/* ── kategória-konstansok (src/JobWatcher.jsx-szel szinkronban) ──── */

// Az első a DB-ben is így hívott leggyengébb kategória, a második nem
// DB-kategória, hanem a "semmire sem illeszkedett" halom neve.
export const FALLBACK_CATEGORY = "Egyéb fejlesztő";
export const UNCATEGORIZED = "Nem kategorizált";

export const CATEGORY_PRIORITY = [
  "DevOps", "Security", "Data / AI", "Elemző / Analyst",
  "QA / Tesztelő", "Mobil", "Menedzser / PM", "UX/UI Design", "Webfejlesztés",
  "Hardware", "Mérnöki / Gyártás", "Hálózat / Infra", FALLBACK_CATEGORY,
];

const categoryRank = (c) => {
  const i = CATEGORY_PRIORITY.indexOf(c);
  return i === -1 ? CATEGORY_PRIORITY.length : i;
};

const collapseByPriority = (cats) => {
  if (cats.length <= 1) return cats;
  return [[...cats].sort((a, b) => categoryRank(a) - categoryRank(b))[0]];
};

// Kulcsszó → regex. Alapból mindkét oldalon szóhatár, hogy a "qa" ne
// illeszkedjen a "qatar"-ra; a `*` jelöli, hol NEM kell szóhatár
// ("fejleszt*" → előtag, "*fejleszt*" → bárhol a szóban).
export function kwRegex(kw) {
  const openLeft = kw.startsWith("*");
  const openRight = kw.endsWith("*");
  const core = kw.replace(/^\*/, "").replace(/\*$/, "");
  if (!core) return /(?!)/; // csupa `*` kulcsszó mindenre illeszkedne
  const escaped = core.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const left = openLeft ? "" : "(^|[^a-z0-9])";
  const right = openRight ? "" : "([^a-z0-9]|$)";
  return new RegExp(`${left}${escaped}${right}`, "i");
}

/* ── egy állás → pontosan egy kategória (vagy [] = nem kategorizált) ── */

export function getCategoriesForJob(job, jobCategories) {
  if (!job.title || !jobCategories.length) return [];
  const title = job.title.toLowerCase();
  const matches = jobCategories
    .filter(([, keywords]) => (keywords || []).some((kw) => kwRegex(String(kw).toLowerCase()).test(title)))
    .map(([cat]) => cat);

  // A két kemény szabály a kulcsszavak MEGKERÜLÉSÉVEL sorol be — de nem
  // írhatja felül a konkrét szakma-találatot ("SOC Analyst" security-s,
  // "test analyst" tesztelő, "UX Designer – AI experiences" UX-es).
  const STRONG_CATEGORIES = ["Security", "QA / Tesztelő", "UX/UI Design"];
  const hasStrongMatch = matches.some((c) => STRONG_CATEGORIES.includes(c));

  if (!hasStrongMatch && (title.includes("analyst") || title.includes("elemző"))) {
    return ["Elemző / Analyst"];
  }
  // Különálló "AI" token → Data / AI, DE csak ha az AI a szakterület: az
  // "AI-assisted developer" fejlesztő, aki AI-t HASZNÁL, nem AI-fejlesztő.
  const aiIsModifier =
    /(^|[^a-z0-9])ai[-\s](assisted|enabled|native|powered|empowered|driven|first|asszisztált|asszisztalt|alapú|alapu|támogatott|tamogatott)/i.test(job.title);
  if (!hasStrongMatch && !aiIsModifier && /(^|[^a-z0-9])ai([^a-z0-9]|$)/i.test(job.title)) {
    return ["Data / AI"];
  }
  if (!hasStrongMatch && matches.length > 1 && matches.includes("Elemző / Analyst") && (title.includes("analyst") || title.includes("elemző"))) {
    return ["Elemző / Analyst"];
  }
  if (matches.length > 1 && matches.includes("DevOps")) {
    return ["DevOps"];
  }
  // A gyűjtő-kategória a leggyengébb: ha bármi más is matchelt, az nyerjen.
  const withoutFallback = matches.filter((c) => c !== FALLBACK_CATEGORY);
  const effective = withoutFallback.length > 0 ? withoutFallback : matches;
  let result;
  if (effective.length > 1 && effective.includes("Hálózat / Infra")) {
    result = effective.filter((c) => c !== "Hálózat / Infra");
  } else if (effective.length > 1 && effective.includes("Mérnöki / Gyártás")) {
    result = effective.filter((c) => c !== "Mérnöki / Gyártás");
  } else {
    result = effective;
  }
  return collapseByPriority(result);
}

// Sorok → [{category, count}] (a 0-s kategóriák kimaradnak).
export function categorizeJobs(rows, jobCategories) {
  const counts = {};
  for (const [cat] of jobCategories) counts[cat] = 0;
  counts[UNCATEGORIZED] = 0;

  for (const row of rows) {
    const cats = getCategoriesForJob(row, jobCategories);
    if (cats.length === 0) {
      counts[UNCATEGORIZED]++;
    } else {
      for (const cat of cats) counts[cat] = (counts[cat] || 0) + 1;
    }
  }

  return Object.entries(counts)
    .filter(([, c]) => c > 0)
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count);
}

/* ── diák/intern felismerés ──────────────────────────────────────── */

const ZERO_RANGE_EXPERIENCE_REGEX =
  String.raw`(^|[^0-9])(0\s*[-–/]\s*[1-9][0-9]*|0\s*(?:\+)?\s*(?:év|éves|ev|eves|year|years|yr|yrs))([^0-9]|$)`;
const zeroRangeRegex = new RegExp(ZERO_RANGE_EXPERIENCE_REGEX, "i");

export function isInternJob(row) {
  const title = (row.title || "").toLowerCase();
  const experience = (row.experience || "").toLowerCase();
  return (
    INTERN_SOURCES.includes(row.source) ||
    INTERNSHIP_KEYWORDS.some((kw) => title.includes(kw)) ||
    INTERNSHIP_KEYWORDS.some((kw) => experience.includes(kw)) ||
    zeroRangeRegex.test(experience)
  );
}

/* ── egy nap összesítése ─────────────────────────────────────────── */

// A senior hirdetéseket kihagyjuk: a board is elrejti őket alapból
// (isSeniorExperience(experience, title) — a CÍM is számít, mert a régi,
// seniorAwareExperience előtti sorok experience-e nincs "senior"-ra állítva).
export function computeDayStats(rows, jobCategories) {
  const jobs = rows.filter((row) => !isSeniorExperience(row.experience, row.title));
  const internJobs = jobs.filter(isInternJob);

  return {
    totalJobs: jobs.length,
    internJobs: internJobs.length,
    categories: categorizeJobs(jobs, jobCategories),
    internCategories: categorizeJobs(internJobs, jobCategories),
  };
}
