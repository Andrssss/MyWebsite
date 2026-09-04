// src/lib/experienceLevel.mjs
//
// Szint-besorolás a szabad szöveges `experience` mezőből + cím/forrás
// heurisztikából. **Az `allasfigyelo` (pestidev.hu) repo `app/lib/experience.ts`
// 1-1 portja** — user-döntés 2026-09-01. A statisztika (`_stats_core.mjs`)
// innen veszi a senior-kizárást és a diák/intern felismerést, hogy a
// `job_daily_stats` számai pontosan azt jelentsék, amit a publikus board mutat.
//
// FIGYELEM: ez NEM keverendő a `netlify/functions/_experience_core.mjs`-sel.
// Az a SCRAPEREK írási oldala (mit írunk be a `job_posts.experience`-be);
// ez az OLVASÁSI oldal (a beírt értéket hogyan soroljuk szintbe). A kettőnek
// szándékosan más a szabálya, és a scraper-oldalhoz itt nem szabad hozzányúlni.

export const INTERN_KEYWORDS = ["intern", "gyakornok", "trainee", "diák", "diákmunka", "talent"];

/** Diákszövetkezeti források: definíció szerint gyakornoki, sosem junior/medior. */
export const INTERN_ONLY_SOURCES = [
  "minddiak",
  "muisz",
  "zyntern",
  "schonherz",
  "tudasdiak",
  "vizmuvek",
  "tudatosdiak",
  "ydiak",
  "qdiak",
  "miszisz",
];

const norm = (v) => String(v ?? "").trim().toLowerCase();

/**
 * Ékezet-biztos szóhatár. A JS `\b` az [A-Za-z0-9_] ellen van definiálva, tehát
 * az `ő` NEM szó-karakter, és a `/\bpályakezdő\b/` szó végén sosem illeszkedik
 * — a v1 prototípus pont ezt a hibát hordozta, némán kiejtve minden
 * "pályakezdő" hirdetést a junior szűrőből. A Unicode property escape-ek adnak
 * magyarul is működő szóhatárt.
 */
const wordRe = (alternatives) =>
  new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives})(?![\\p{L}\\p{N}])`, "u");

const JUNIOR_TOKENS = wordRe("junior|palyakezdo|pályakezdő|entry\\s*level|trainee|intern");
const MEDIOR_TOKENS = wordRe("medior|mid|middle");
const SENIOR_TOKENS = wordRe("senior|szenior|lead");

const hasJuniorToken = (e) => JUNIOR_TOKENS.test(e);
const hasMediorToken = (e) => MEDIOR_TOKENS.test(e);

/** Csak önálló 0 vagy 1 — a "10 years" nem olvasható juniornak. */
const hasJuniorYear = (e) => /(^|\D)(0|1)(\D|$)/.test(e);

const isUnknown = (e) => e === "" || e === "-" || e === "–" || e === "—";

/** Csak "nincs adat" helykitöltő (üres vagy csupasz gondolatjel)? */
export const isUnknownValue = (value) => isUnknown(norm(value));
export const isUnknownExperience = (experience) => isUnknownValue(experience);

/** A címkézetlen hirdetés juniornak számít: szándékosan megengedő. */
export function isJunior(experience) {
  const e = norm(experience);
  if (isUnknown(e)) return true;
  if (hasMediorToken(e)) return false;
  return hasJuniorToken(e) || hasJuniorYear(e);
}

export function isMedior(experience) {
  const e = norm(experience);
  if (isUnknown(e)) return true;
  if (hasMediorToken(e)) return true;
  if (hasJuniorToken(e)) return false;
  return !hasJuniorYear(e);
}

export const SENIOR_MIN_YEARS = 5;

/**
 * Senior, ha explicit senioritási szó szerepel, VAGY ha a szövegben a LEGKISEBB
 * szám >= 5. A legkisebb, nem a legnagyobb: a "3-5 év" minimuma 3, az még
 * junior-elérhető; az "5-10 years" minimuma 5, az már nem.
 */
export function isSenior(experience) {
  const e = norm(experience);
  if (SENIOR_TOKENS.test(e)) return true;
  const nums = e.match(/\d+/g);
  if (!nums) return false;
  return Math.min(...nums.map((n) => parseInt(n, 10))) >= SENIOR_MIN_YEARS;
}

export function isInternSource(source) {
  const s = norm(source);
  return INTERN_ONLY_SOURCES.some((k) => s.includes(k));
}

export function isInternLike(job) {
  const title = norm(job.title);
  const exp = norm(job.experience);
  const titleHit = INTERN_KEYWORDS.some((k) => title.includes(k));
  const expHit = INTERN_KEYWORDS.some((k) => exp.includes(k));
  return isInternSource(job.source) || ((titleHit || expHit) && !title.includes("junior"));
}

/**
 * A junior/medior szűrő kihagyja azt, ami valójában gyakornoki — kivéve ha az
 * experience mező kifejezetten juniort mond, az felülírja a cím-heurisztikát.
 */
export function isJuniorTrackCandidate(job) {
  const title = norm(job.title);
  const exp = norm(job.experience);
  const internSource = isInternSource(job.source);
  const internExp = INTERN_KEYWORDS.some((k) => exp.includes(k));

  if (hasJuniorToken(exp)) return !internSource && !internExp;

  const internTitle = INTERN_KEYWORDS.some((k) => title.includes(k));
  return !internSource && !internTitle && !internExp;
}

export const LEVEL_VALUES = ["intern", "junior", "medior", "senior", "ambiguous"];

/**
 * Egyetlen szint-érték egy hirdetésre — a `job_posts.level` mezőt ez tölti fel.
 * A fenti eligibility-függvények (isJunior/isMedior/isSenior/isInternLike) egy-egy
 * szűrőre válaszolnak és szándékosan permisszívek (egy ismeretlen experience-re
 * mindkettő true); ez a függvény ELSŐ TALÁLATOS prioritási sorrendben egyetlen
 * értéket választ, hogy SQL-ben egyszerűen lehessen szűrni rá.
 *
 * Sorrend: diákszövetkezeti FORRÁS mindig intern (a szövegtől függetlenül) >
 * senior (isSenior — csak az experience szövegre néz, cím-alapú senior-szót
 * szándékosan NEM néz, ld. a 2026-09-04-es JobWatcher.jsx-javítást a "Staff"
 * címekről) > cím/experience-kulcsszó alapú intern (isInternLike) > explicit
 * medior-token (isMedior && !isJunior — a medior nyer, ha mindkettő jelen van,
 * ld. isMedior/isJunior tie-breaket) > explicit junior-token vagy 0/1 év >
 * "ambiguous" (nincs experience-adat, vagy egyik token/évszám sem egyértelmű).
 */
export function computeLevel(job) {
  if (isInternSource(job.source)) return "intern";
  if (isSenior(job.experience)) return "senior";
  if (isInternLike(job)) return "intern";

  if (isUnknownValue(job.experience)) return "ambiguous";

  const medior = isMedior(job.experience);
  const junior = isJunior(job.experience);
  if (medior && !junior) return "medior";
  if (junior && !medior) return "junior";
  return "ambiguous";
}
