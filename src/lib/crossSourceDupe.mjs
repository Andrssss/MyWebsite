/*
  Cross-source duplicate key — the pure matching logic shared by the ingest-side
  guard (netlify/functions/_cross_source_dupe.mjs, which adds the DB lookup on
  top) and the admin board's "Átfedés" badge (src/JobWatcher.jsx). One copy so
  the two can't silently diverge — see src/lib/categorize.mjs for the same
  pattern with the category rules.

  The dedupe key is deliberately the one the site owner asked for:

      <first real word of company>  |  <normalized title>

  2026-08-28 to 2026-09-01: matched against EVERY other source, not a
  whitelist — a hardcoded "sources worth checking" list is the exact bug class
  this repo keeps hitting (melonjobs / unicredit taxonomy-ID lists), and
  checking all of them cost only one extra query per run.

  2026-09-02: switched to a shared whitelist (`CROSS_SOURCE_DUPE_SOURCES`
  below) once a 3rd caller (ats-crawl) needed the same guard but only overlaps
  a handful of sources — indexing the whole table for it would have been a much
  bigger query for no extra hit rate. The whitelist-drift risk above is still
  real, so there is exactly ONE list, shared by every caller (not one per
  file): a newly found overlap gets added here once and every caller picks it
  up, instead of several lists silently diverging.

  Company-name normalization has to survive raw ATS entity labels, which is
  what startup.jobs actually serves: "100 Shift4 Payments, LLC",
  "111 - GoTo Technologies USA, LLC", "8100 United States - Genesys Cloud
  Services, Inc.", "435 Itron Mgmt Svcs Ireland, Ltd", "C_001 Transaction
  Network Services, Inc.", "BR02 VALEO SISTEMAS AUTOMOTIVOS LTDA". A naive
  "first word" on those yields "100"/"111"/"8100"/"c_001"/"br02" and matches
  nothing, so a leading numeric/alphanumeric entity code is stripped first —
  and ONLY when such a code was present may a following "<region> - " segment
  be stripped too ("8100 United States - Genesys …" → "genesys"). Without that
  guard a legitimate name like "Roland Berger - Digital" would lose its head.
*/

function stripDiacritics(s) {
  return String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "");
}

// Title key: lowercase, accent-free, punctuation-free, whitespace-collapsed.
// The only semantic normalization is the frontend/backend/fullstack spacing
// variance — pure spelling, and it is what made a real duplicate slip through
// the first analysis pass ("Frontend Engineer" vs LinkedIn's "front end
// engineer" at Qneiform). Deliberately NOT normalizing developer↔engineer or
// dropping seniority words: those are different jobs often enough to matter.
export function normalizeDupeTitle(title) {
  return stripDiacritics(title)
    .toLowerCase()
    .replace(/front[\s-]?end/g, "frontend")
    .replace(/back[\s-]?end/g, "backend")
    .replace(/full[\s-]?stack/g, "fullstack")
    .replace(/[^a-z0-9+#]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

// First meaningful word of the company name (see header for the entity-code
// handling). Returns "" when there is nothing usable — callers must treat an
// empty key as "cannot compare", never as a match.
export function normalizeDupeCompany(company) {
  let s = stripDiacritics(company).trim();
  if (!s) return "";

  // Leading ATS entity code: "8100 ", "435 ", "BR02 ", "C_001 ".
  const codeMatch = s.match(/^([0-9]+|[A-Za-z]{1,3}[_-]?[0-9]{2,5})\s+/);
  if (codeMatch) {
    s = s.slice(codeMatch[0].length);
    // Only now is a "<region/whatever> - " prefix safe to drop.
    const seg = s.match(/^[^-–]{1,30}[-–]\s+/);
    if (seg) s = s.slice(seg[0].length);
  }

  const words = s.toLowerCase().split(/[^a-z0-9+]+/).filter(Boolean);
  for (const w of words) if (w.length >= 2) return w;
  return words[0] ?? "";
}

export function dupeKey(company, title) {
  const c = normalizeDupeCompany(company);
  const t = normalizeDupeTitle(title);
  if (!c || !t) return "";
  return `${c}|${t}`;
}

// The sources that measurably re-list postings other scrapers already carry
// (2026-08-28 startup.jobs analysis: 45/56 rows already present under one of
// these; 2026-08-30 workable analysis: 40/186 Budapest rows, same pattern).
// Every current cross-source-dupe caller (startupjobs, workable, ats-crawl,
// and the admin board's "Átfedés" badge) scopes its comparison to this shared
// list instead of the whole table. Extend this list, not a per-caller one,
// when a new overlap is found, so every caller benefits and stays consistent
// (a per-file list is exactly the hardcoded-whitelist bug class the rest of
// this repo keeps hitting — see the header history above).
export const CROSS_SOURCE_DUPE_SOURCES = [
  "ats-crawl",
  "LinkedIn",
  "AI-scraped",
  "profession-intern",
  "alllocaljobs",
  "talent",
  "startupjobs",
  // 2026-09-03: added after a live-DB coverage audit found 44 real cross-source
  // duplicates the whitelist was silently missing, 33 of them explained by just
  // these two. wherewework's overlap is with AI-scraped (Bosch postings, 1:1
  // specific titles). nofluffjobs' overlap spans several tracked sources — but
  // nofluffjobs ALSO produced the title+company false-positive that motivated
  // TECH_MATCH_THRESHOLD below (two genuinely different "DevOps Engineer" reqs
  // at Deutsche Telekom IT Solutions), so it only got added once tech-overlap
  // was in place to guard against that. See cross-source-dupe-coverage memory.
  "wherewework",
  "nofluffjobs",
];

function splitTechList(technologies) {
  return technologies
    ? String(technologies).split(",").map((t) => t.trim()).filter(Boolean)
    : [];
}

// Overlap coefficient (Szymkiewicz–Simpson) of the two technology-tag sets:
// shared ÷ min(|A|, |B|) — NOT Jaccard (shared ÷ union). Tags are a canonical
// keyword table (_tech_keywords.js) applied identically regardless of source,
// so exact string equality is enough — no fuzzy matching needed.
//
// Jaccard was tried first and broke on real data: extraction depth varies a
// lot between site templates (a thin page yields fewer tags even for the
// IDENTICAL posting), and Jaccard punishes the thinner side's set size even
// when it's a clean subset of the richer one. Overlap coefficient instead
// asks "is virtually everything the WEAKER extraction found also present on
// the other side?" — the right question when one source just extracts less.
//
// Returns null (cannot compare — caller falls back to title+company alone)
// whenever the SMALLER side has under MIN_TAGS_FOR_COMPARISON tags. Below
// that, the signal is too weak either direction: a match on 1-3 shared tags
// out of a tiny set isn't trustworthy evidence of "same posting", but a tiny
// set NOT fully contained in the other isn't trustworthy evidence of
// "different posting" either — confirmed live 2026-09-03, a pestidev.hu
// "Test Automation Engineer" @ MP Solutions duplicate (workable, 7 tags; vs
// AI-scraped, only 2 tags, one of which — "Test Automation" — wasn't even in
// workable's list despite the title). Requiring ≥4 tags on the thinner side
// before trusting a rejection would have kept that case falling back to the
// key-only accept, instead of the accidental near-miss it would score with
// Jaccard-style union-punishing math.
const MIN_TAGS_FOR_COMPARISON = 4;

export function technologyOverlap(techA, techB) {
  const a = new Set(splitTechList(techA));
  const b = new Set(splitTechList(techB));
  const minSize = Math.min(a.size, b.size);
  if (minSize < MIN_TAGS_FOR_COMPARISON) return null;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / minSize;
}

// 2026-09-03: two live NoFluffJobs postings, both "DevOps Engineer" @ Deutsche
// Telekom IT Solutions Hungary — same dupeKey, but genuinely different reqs
// (21 vs 25 tags, 8 shared → overlap coefficient 8/21 ≈ 0.38). Generic titles
// at big outsourcing/BPO employers collide on company+title alone with no
// other signal to split them apart. Both sides had plenty of tags (well above
// MIN_TAGS_FOR_COMPARISON), so this is a case where the reject is trustworthy.
//
// 0.5: comfortable margin above that 0.38 false-positive score, while every
// confirmed genuine duplicate found live this session clears it easily —
// "Beyond Sports" (identical lists, 1.0), "test engineer" @ SEON (identical
// 10-tag lists, 1.0), "Embedded C++" @ MP Solutions (workable 12 tags, talent
// 4 tags, all 4 contained → 4/4 = 1.0). Revisit if a false positive with
// genuine, well-populated tech overlap ever turns up (see
// cross-source-dupe-coverage memory for the full decision history).
export const TECH_MATCH_THRESHOLD = 0.5;

// True duplicate-of-the-same-posting check: title+company key must match AND,
// whenever both sides have technologies to compare, they must overlap enough.
// When either side has no technologies, the key match alone stands (see
// technologyOverlap above) — this is the ONLY place that matters: ats-crawl's
// cross-source check runs before its detail-page fetch (so it has no
// technologies yet) and deliberately keeps working key-only, unchanged.
export function isLikelySamePosting(a, b) {
  const key = dupeKey(a.company, a.title);
  if (!key || key !== dupeKey(b.company, b.title)) return false;
  const overlap = technologyOverlap(a.technologies, b.technologies);
  return overlap === null || overlap >= TECH_MATCH_THRESHOLD;
}
