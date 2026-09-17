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

// 2026-09-16 (GH issue #18): the bank / single-company career-site sources —
// each posts its own IT roles directly, with real (if small) risk of the same
// posting also showing up on a big aggregator (LinkedIn, ats-crawl, ...).
// Kept as its own named list, spread into CROSS_SOURCE_DUPE_SOURCES below, so
// _dupe_snapshot.mjs can route just these into a separate low-volume Blob
// instead of the big sources' daily snapshot — see the comment down there.
export const SMALL_COMPANY_DUPE_SOURCES = [
  "mbh",
  "erste",
  "mfb",
  "raiffeisen",
  "unicredit",
  "kh",
  "cg-jobstream",
  // 2026-09-17 (GH issue #24): otp was named in the original #18 sweep too but
  // missed the 09-16 batch — cron_jobs_DIAK_3-background.mjs never wrote a
  // company literal for it, so it stayed invisible to dupeKey the same way the
  // other banks were before that fix.
  "otp",
  // 2026-09-17: kuka (cron_jobs_MIX-background.mjs) — also named in #18's
  // original 9-source list, also missed the 09-16 batch. Same single-employer
  // shape as the rest of this list.
  "kuka",
];

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
  // 2026-09-04: dreamjobs added on request, no separate live-audit run first —
  // if it turns out to have negligible overlap, this is a one-line revert.
  "dreamjobs",
  // 2026-09-05: added after a full-table (all 37 sources, any-pair) audit
  // found 7 real dupeKey collisions with profession-intern — a real, if
  // modest, overlap the whitelist was silently missing. Every other
  // non-whitelisted pair the same audit found was 1-2 rows (noise).
  "nix",
  // 2026-09-08: added after the post-cleanup recheck found the only
  // remaining non-whitelisted collisions were workable (6 pairs, mostly MP
  // Solutions Ltd. re-listed on talent/LinkedIn/AI-scraped) and workly (2
  // pairs). Both already-wired sources (LinkedIn, talent, profession-intern,
  // nofluffjobs, nix, ats-crawl, startupjobs, dreamjobs, workable itself)
  // pick these up automatically via CROSS_SOURCE_DUPE_SOURCES — no separate
  // scraper wiring needed for workable/workly themselves.
  "workable",
  "workly",
  // 2026-09-15: added when the new cvonline scraper's ROI check found 31/150
  // Hungary-relevant cvonline postings were re-posts already carried by these
  // three direct sources (13 minddiak, 10 trenkwalder, 8 muisz) — a bigger
  // overlap than several already-whitelisted sources' own thresholds (nix's 7
  // pairs, workable's 6). Widens every existing caller's comparison too, not
  // just cvonline's — that's the point of one shared list (see header).
  "minddiak",
  "muisz",
  "trenkwalder",
  // 2026-09-16: bank / single-company career-site sources (GH issue #18) —
  // ats-crawl's SEED_TENANTS doesn't cover any of them (bespoke in-house HR
  // APIs, not a SaaS ATS platform it has an adapter for), but a live sample
  // still showed real risk of the SAME posting being re-listed by a big
  // aggregator source (LinkedIn, ats-crawl, ...), so they belong in the
  // shared whitelist like everything else here. Split into their own
  // sub-list (below) purely for the *storage* side: each of these posts a
  // handful of jobs a day at most, so the once-a-day snapshot Blob's
  // performance rationale (skip a full job_posts scan on every high-volume
  // scraper run) doesn't apply — they get their own small "dupe-snapshot-small"
  // Blob instead of being folded into the big sources' "dupe-snapshot" one.
  // See SMALL_COMPANY_DUPE_SOURCES + netlify/functions/_dupe_snapshot.mjs.
  ...SMALL_COMPANY_DUPE_SOURCES,
  // 2026-09-16/17: recovered from an unmerged branch (origin/claude/database-
  // duplication-q79v16, commit 7cd0c1e) whose whitelist widening never made it
  // to main — a separate same-day commit (cebd6b7) added the bank sources
  // above via its own SMALL_COMPANY_DUPE_SOURCES but didn't carry these 5. The
  // branch's own source: an external fuzzy title/company-similarity pairing
  // run against a live DB export (pestidev_teljes_parositas_2026-09-16.csv,
  // 487 pairs) found each of these — every one its own single-employer/
  // aggregator scraper never wired into loadCrossSourceDupeIndex at all — on
  // one side of 236 unprotected pairs (karrierhungaria 13, qdiak 12, zyntern
  // 4, schonherz 4). IMPORTANT caveat carried over from that commit: re-running
  // this repo's own dupeKey() (exact-match) against that same CSV matched only
  // 2 of the 236 — the external tool scores continuous similarity, which
  // catches near-misses (missing company, reworded titles, HU vs EN phrasing)
  // this repo's exact key never will. So this addition is correct and costs
  // nothing going forward, but it will NOT retroactively clean the existing
  // backlog and will keep missing most future near-duplicates from these
  // sources too — the real gap is the exact-match strategy itself, not just
  // this whitelist (see cross-source-dupe-coverage memory).
  "karrierhungaria",
  "qdiak",
  "zyntern",
  "schonherz",
  "atlasz",
];

function splitTechList(technologies) {
  return technologies
    ? String(technologies).split(",").map((t) => t.trim()).filter(Boolean)
    : [];
}

// 2026-09-03: tried a fuzzy overlap-coefficient threshold first, dropped it —
// extraction depth varies too wildly between site templates (same posting,
// 12 tags on one source vs 2 on another, sometimes not even a strict subset)
// to trust ANY numeric threshold across different sources' extraction
// pipelines. Explicitly rejected by the site owner as "40% bullshit" after
// several live near-misses.
//
// This function is scoped to SAME-SOURCE comparisons ONLY (two rows from the
// identical scraper, same dupeKey, different url — e.g. a source with no
// stable URL re-listing the same posting, or a title+company that genuinely
// collides across different real reqs on that one source, like the Deutsche
// Telekom "DevOps Engineer" case, which was 4 rows on nofluffjobs itself).
// Within ONE source, the extraction pipeline is identical every time, so an
// EXACT tag-set match is the trustworthy signal: same posting re-scraped →
// same tags; a different req sharing the same title+company → different
// tags. No threshold, no partial credit.
//
// NEVER use this for cross-source comparisons — see CROSS_SOURCE_DUPE_SOURCES
// below and isLikelySamePosting's doc comment.
export function technologiesExactMatch(techA, techB) {
  const a = splitTechList(techA);
  const b = splitTechList(techB);
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((t) => setB.has(t));
}

// Same-source duplicate check: title+company key must match AND the
// technology tag sets must match EXACTLY (see technologiesExactMatch above).
// Scoped to SAME-SOURCE use only — two rows from the SAME `source` value.
// Cross-source matching must use dupeKey() alone, with no technology
// involved at all: extraction quality differs too much between site
// templates to trust as a cross-source signal (confirmed on live data
// several times 2026-09-03 — see cross-source-dupe-coverage memory). Cross-
// source candidates are recorded for human review, never auto-merged; they
// do not call this function.
export function isLikelySamePosting(a, b) {
  const key = dupeKey(a.company, a.title);
  if (!key || key !== dupeKey(b.company, b.title)) return false;
  return technologiesExactMatch(a.technologies, b.technologies);
}
