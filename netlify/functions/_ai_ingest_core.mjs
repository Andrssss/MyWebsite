// netlify/functions/_ai_ingest_core.mjs
//
// Shared ingest tail for the `ai-scraped` pipeline: given already-extracted job
// rows for one site, apply the same filtering + url-keyed upsert + reconcile that
// every hand scraper uses, and write them to source `AI - <site>`.
//
// One code path, three callers:
//   • ai-ingest.js         — jobs I (or a local script) extracted in-session NOW
//   • cron_jobs_AI-background.mjs — jobs the LLM extracted (LATER / automated)
//   • a future local script
//
// This module does NOT fetch or call any LLM — HTML/LLM lives in
// _ai_extract_core.mjs. See AI_SCRAPER_PLAN.md.

import { reconcileActive } from "./_active_core.mjs";
import { isBlockedCompany } from "./_company_blocklist.mjs";
import {
  isInternshipTitle, isJuniorTitle, isMidLevelTitle, ensureTechnologiesColumn,
  extractYearsFromText,
} from "./_experience_core.mjs";

/* ── url/row normalization (shared by every caller-supplied write path) ──
   Lives here so ai-ingest.mjs and ai-registry.mjs can't drift apart on what
   counts as the same url — `url` IS the row identity for the ON CONFLICT
   upsert below, so two endpoints normalizing differently would silently
   create duplicate rows for one posting. */

const TRACKING = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid"];

// Single flat DB source for EVERY ai-scraped find (user decision 2026-07-21):
// one "AI-scraped" bucket instead of per-company `AI - <slug>` sources. The
// routine still tracks companies by slug in its registry memory, but the
// `job_posts.source` value is always this. Legacy `AI - <slug>` rows are
// collapsed into it by the migration in ai-registry.mjs.
export const AI_SOURCE = "AI-scraped";

export function toSlug(s) {
  return String(s || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function normalizeUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    TRACKING.forEach((p) => u.searchParams.delete(p));
    return u.toString().replace(/\?$/, "");
  } catch {
    return null;
  }
}

function trimField(v, max) {
  if (!v) return null;
  return String(v).replace(/\s+/g, " ").trim().slice(0, max) || null;
}

// Normalize + dedupe caller-supplied rows. No HTML hallucination guard here —
// these callers are trusted via bearer token; that guard lives in
// _ai_extract_core.mjs, which is the one path handling raw LLM output.
export function sanitizeJobs(rawJobs) {
  const seen = new Set();
  const out = [];
  for (const j of rawJobs || []) {
    if (!j || typeof j.title !== "string" || typeof j.url !== "string") continue;
    const title = j.title.replace(/\s+/g, " ").trim();
    const url = normalizeUrl(j.url.trim());
    if (title.length < 3 || !url || seen.has(url)) continue;
    seen.add(url);
    out.push({
      title: title.slice(0, 300),
      url,
      company: trimField(j.company, 200),
      location: trimField(j.location, 200),
      experience: trimField(j.experience, 100),
      technologies: trimField(j.technologies, 500),
    });
  }
  return out;
}

/* ── IT-only gate (user rule 2026-07-16: ai-scraped accepts ONLY IT jobs) ──
   Reuses the SAME job_categories keyword lists the rest of the app uses for
   classification (loadCategories(), see cron_daily_stats.mjs / JobWatcher.jsx)
   — a job counts as "IT" if its title hits ANY category's keywords (plus the
   two standalone hardcoded triggers those files also special-case: "analyst"/
   "elemző", and a standalone "AI" token). This is deliberately just the
   accept/reject test, NOT the single-winner CATEGORY_PRIORITY tie-break those
   files use afterward to pick ONE category — we don't need to pick one here,
   only to decide IT vs not. */

function kwRegex(kw) {
  const escaped = String(kw).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i");
}

export function isItJob(title, categories) {
  const t = String(title || "").toLowerCase();
  if (!t) return false;
  if (t.includes("analyst") || t.includes("elemző")) return true;
  if (/(^|[^a-z0-9])ai([^a-z0-9]|$)/i.test(title || "")) return true;
  return (categories || []).some(([, kws]) => (kws || []).some((kw) => kwRegex(kw.toLowerCase()).test(t)));
}

/* ── senior filter (same rule as every scraper) ──────────────────── */

function normalizeText(s) {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function blacklistRegex(k) {
  const escaped = normalizeText(k).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i");
}

export function isSeniorLike(title, filters) {
  const n = normalizeText(title);
  return (filters || []).some((k) => blacklistRegex(k).test(n));
}

// Title beats body — SAME precedence every other scraper uses (see e.g.
// cron_jobs_ALLASPORTAL-background.mjs): a title hit for diákmunka/junior/
// medior always wins. Only when the title gives no signal ("-") does a
// caller-supplied body-derived value (job.experience, e.g. a "8 év" years
// phrase from extractBodyExperience) get used. Row must be fully built
// BEFORE insert — no separate fetch-then-UPDATE (experience-write-policy).
//
// A level WORD (junior/medior/senior/...) in job.experience is NEVER trusted,
// even when it's exactly one of the three canonical words — only a title
// match (above) can produce a level label. Every prior attempt to carve out
// an exception here has reintroduced the same bug: 2026-07-21 (flexinform
// "Automata szoftvertesztelő", body said "Legalább 2 év", title said nothing,
// row got stamped "medior" from the caller's own reading), 2026-07-22 (a
// free-text sentence with no level word sailed through, fixed by routing
// through extractYearsFromText), and 2026-07-23 (sysdata-pse.com
// "Tesztautomatizálási mérnök" — title has no level word, the actual body has
// NO years figure and NO junior/medior word anywhere, yet still got stamped
// "medior", because that run's fix trusted job.experience whenever it
// happened to equal one of the three canonical words verbatim — the AI's own
// bare guess, not anything extracted from real text). The only two sources of
// truth for a level label are the title (code-verified above) and an actual
// years-of-experience figure in the body — nothing else, ever.
function resolveExperience(job) {
  const fromTitle = isInternshipTitle(job.title) ? "diákmunka"
    : isJuniorTitle(job.title) ? "junior"
    : isMidLevelTitle(job.title) ? "medior"
    : "-";
  if (fromTitle !== "-") return fromTitle;

  const raw = job.experience && job.experience !== "-" ? job.experience.trim() : "-";
  if (raw === "-") return "-";
  return extractYearsFromText(raw) || "-";
}

// NB: az AI-pipeline korábban a body-ból BECSÜLT évszám alapján is dobott
// (isSeniorByYears, küszöb 3 év) — ezt 2026-07-20-án kivettük (user-döntés):
// a magas évszámos találatot is elmentjük, a frontend csak megjelöli (senior
// badge). A cím-denylist (isSeniorLike) maradt az egyetlen senior-kapu itt is,
// mint minden más scrapernél.

/* ── upsert (row fully built BEFORE insert — experience-write-policy) ── */

async function upsertJob(client, source, job, resolvedExperience) {
  // AI-scraped postings start hidden — this pipeline discovers new sites
  // automatically with less vetting than a hand-written scraper, so a human
  // reviews (job-hidden.js un-hide) before it reaches the public board.
  // `hidden` is deliberately absent from the ON CONFLICT SET below: once a row
  // exists, a re-ingest (the same posting found again on a later run) must
  // never re-hide it or re-clobber an admin's un-hide decision — same
  // anti-clobber policy already used here for `experience`.
  const startsHidden = source === AI_SOURCE;
  await client.query(
    `INSERT INTO job_posts (source, title, url, experience, company, technologies, first_seen, hidden)
     VALUES ($1,$2,$3,$4,$5,$6,NOW(),$7)
     ON CONFLICT (source, url) DO UPDATE SET
        experience = CASE
          WHEN (job_posts.experience IS NULL OR job_posts.experience IN ('-', ''))
           AND EXCLUDED.experience NOT IN ('-', '')
          THEN EXCLUDED.experience ELSE job_posts.experience END,
        technologies = COALESCE(job_posts.technologies, EXCLUDED.technologies),
        company = CASE
          WHEN job_posts.company IS NULL THEN EXCLUDED.company
          ELSE job_posts.company END`,
    [source, job.title, job.url, resolvedExperience, job.company || null, job.technologies || null, startsHidden]
  );
}

/* ── ingest ──────────────────────────────────────────────────────── */

/**
 * Filter + upsert + reconcile one site's extracted rows.
 *
 * @param {import("pg").PoolClient} client
 * @param {object} args
 * @param {string} args.source        DB source value, e.g. "AI - example"
 * @param {Array}  args.jobs          [{ title, url, company?, location?, experience?, technologies? }]
 *                                    — already validated/normalized. `experience`/`technologies` are
 *                                    OPTIONAL body-derived values (read the detail page, same as every
 *                                    hand scraper's fetch-before-insert step — extractBodyExperience /
 *                                    extractTechnologies in _experience_core.mjs, or the in-session
 *                                    equivalent). Title-based classification always wins when it
 *                                    matches; these only fill the gap when the title gives no signal.
 * @param {boolean} [args.fullListing=false]  true only if `jobs` is the ENTIRE current listing
 *                                    (then reconcile may deactivate vanished rows; otherwise
 *                                    reactivate-only — the 404 sweep owns deaths).
 * @param {string[]} [args.filters=[]]  senior-title blacklist (loadFilters()).
 * @param {Array}    [args.categories=[]]  [[name, keywords[]], ...] from loadCategories() —
 *                                    REQUIRED gate: only IT-matching titles are accepted.
 */
export async function ingestJobs(client, { source, jobs, fullListing = false, filters = [], categories = [] }) {
  await ensureTechnologiesColumn(client);
  const ok = jobs.length > 0;
  const complete = ok && !!fullListing;

  const foundUrls = []; // FULL pre-filter set → a filter change can't deactivate a live job (F3).
  const insertedUrls = []; // Only rows that passed every gate — callers use this to record what
                           // actually reached the DB, rather than what they hoped to write.
  let skippedSenior = 0;
  let skippedCompany = 0;
  let skippedNonIt = 0;

  for (const job of jobs) {
    if (!job || !job.title || !job.url) continue;
    foundUrls.push(job.url);
    if (!isItJob(job.title, categories)) { skippedNonIt++; continue; }
    if (isSeniorLike(job.title, filters)) { skippedSenior++; continue; }
    // Évszám-alapú senior NEM dob többé (user-döntés 2026-07-20): a magas
    // évszámos AI-találatot is elmentjük, a frontend csak megjelöli (senior
    // badge). A cím-denylist (isSeniorLike) marad, mint minden scrapernél.
    const resolvedExperience = resolveExperience(job);
    if (isBlockedCompany(job.company, source)) { skippedCompany++; continue; }
    await upsertJob(client, source, job, resolvedExperience);
    insertedUrls.push(job.url);
  }

  let reconcile = { skipped: true };
  if (ok) {
    reconcile = await reconcileActive(client, source, foundUrls, { complete });
  }

  return {
    rows: jobs.length, inserted: insertedUrls.length, insertedUrls,
    skippedSenior, skippedCompany, skippedNonIt, ok, complete, reconcile,
  };
}
