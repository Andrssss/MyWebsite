// netlify/functions/_stats_core.mjs
//
// A napi statisztika szerveroldali magja: kategorizálás + senior-kizárás +
// diák/intern felismerés + nap-szintű összesítés.
//
// **2026-09-01 (user-döntés): a szabályok NEM itt laknak.** A `job_daily_stats`
// és a `job_daily_categories` táblákat a publikus pestidev.hu
// (`allasfigyelo` repo) statisztika-oldala olvassa, tehát a számoknak pontosan
// azt kell jelenteniük, amit ANNAK a boardnak a szűrői mutatnak. Ezért a
// besorolás az `app/lib/categorize.ts` és `app/lib/experience.ts` 1-1 portjából
// jön:
//   - src/lib/categorize.mjs      → cím → pontosan egy kategória
//   - src/lib/experienceLevel.mjs → senior / diák-gyakornoki felismerés
// Ugyanezt a két modult használja a `src/JobWatcher.jsx` admin board is, tehát
// nincs többé külön szerver- és frontend-másolat, ami szétcsúszhatna.
//
// Ez a fájl innentől CSAK az összesítés: a szabályokat a fenti két modulban
// kell javítani (a pestidev.hu-val együtt), és utána újra kell építeni a
// statisztikát (`_stats_rebuild_core.mjs`) — a mentett napok derivált adatok.
//
// Ami korábban ITT volt és ELTŰNT (a v2 szabálysorában nem létezik):
//   - a `*`-os kulcsszó-szintaxis → helyette `~` SZÓTŐ-előtag;
//   - a "Nem kategorizált" halomnév → helyette `Egyéb`;
//   - az "Egyéb fejlesztő" fallback-név → a DB-beli valódi `Fejlesztő`
//     (emiatt a "gyűjtő a leggyengébb" szabály eddig SOSEM sült el);
//   - a STRONG_CATEGORIES / ai-assisted kivételek → helyettük a v2 0-3.
//     szabálya (Talent Pool rövidzár, analyst-kivételek, önálló AI token);
//   - a cím-alapú senior-felismerés → a v2 kizárólag az `experience` mezőt
//     nézi (a scraperek `_experience_core.mjs`-e ettől FÜGGETLEN, azt nem
//     szabad ehhez igazítani: az az ÍRÁSI oldal).

import { categorize, UNCATEGORIZED } from "../../src/lib/categorize.mjs";
import { isInternLike, isSenior } from "../../src/lib/experienceLevel.mjs";

export { categorize, UNCATEGORIZED } from "../../src/lib/categorize.mjs";
export { isInternLike, isSenior } from "../../src/lib/experienceLevel.mjs";

/** Sorok → [{category, count}] (a 0-s kategóriák kimaradnak). */
export function categorizeJobs(rows, jobCategories) {
  const counts = {};
  for (const [cat] of jobCategories) counts[cat] = 0;
  counts[UNCATEGORIZED] = 0;

  for (const row of rows) {
    const cat = categorize(row.title || "", jobCategories);
    counts[cat] = (counts[cat] || 0) + 1;
  }

  return Object.entries(counts)
    .filter(([, c]) => c > 0)
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Egy nap összesítése.
 *
 * A senior hirdetéseket kihagyjuk, mert a board is elrejti őket alapból
 * (pestidev.hu: `applyLevelFilter` → `isSenior(j.experience) === senior`,
 * ahol a `senior` kapcsoló alapból hamis).
 */
export function computeDayStats(rows, jobCategories) {
  const jobs = rows.filter((row) => !isSenior(row.experience));
  const internJobs = jobs.filter(isInternLike);

  return {
    totalJobs: jobs.length,
    internJobs: internJobs.length,
    categories: categorizeJobs(jobs, jobCategories),
    internCategories: categorizeJobs(internJobs, jobCategories),
  };
}
