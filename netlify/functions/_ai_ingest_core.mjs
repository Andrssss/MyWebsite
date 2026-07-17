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
} from "./_experience_core.mjs";

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
function resolveExperience(job) {
  const fromTitle = isInternshipTitle(job.title) ? "diákmunka"
    : isJuniorTitle(job.title) ? "junior"
    : isMidLevelTitle(job.title) ? "medior"
    : "-";
  if (fromTitle !== "-") return fromTitle;
  return job.experience && job.experience !== "-" ? job.experience : "-";
}

// AI-scraped-ONLY guard (2026-07-16): a generic title ("Java szoftverfejlesztő")
// can hide a body that demands 5-8+ years — the title-keyword blacklist above
// can never catch this since the title itself says nothing senior. None of the
// other ~30 hand scrapers reject on body-stated years (they just record it
// honestly for stats); this pipeline is stricter on purpose, since every OTHER
// site we scrape was individually vetted as student/entry-level-focused, while
// an AI-discovered career page has no such guarantee. Only fires on a raw
// years-phrase (resolveExperience's body-derived fallback) — a title-matched
// "medior" is a legitimate category elsewhere and is NOT rejected here.
const SENIOR_YEARS_THRESHOLD = 3;
const CANONICAL_EXPERIENCE_LABELS = new Set(["diákmunka", "junior", "medior", "-"]);

// Returns the effective "required years" number to compare against the
// threshold. A RANGE ("1-3 év") signals the poster accepts the LOWER bound —
// treating it like a flat "3 év" floor (i.e. taking the max) would wrongly
// reject a genuinely junior-friendly "1-3 év" the same way bap.hu's unambiguous
// "legalább 8 év" / "legalább 5 éves" floors were correctly rejected (real
// case: WM Rendszerház "Back End Fejlesztő" stated "1-3 év szakmai
// tapasztalat" — the 1-year floor is the real signal, not the 3-year ceiling).
// A plain floor ("legalább N év", "N+ years") has no lower bound to prefer, so
// that case still takes the max across all such mentions (handles an ad
// stating multiple requirements).
function parseMaxYears(text) {
  if (!text) return null;
  const s = String(text);

  const rangeMatches = [...s.matchAll(/(\d+)\s*[-–]\s*(\d+)\s*\+?\s*(?:év|éves|ev|eves|years?|yrs?)/gi)];
  if (rangeMatches.length) {
    return Math.min(...rangeMatches.map((m) => parseInt(m[1], 10)));
  }

  let max = null;
  for (const m of s.matchAll(/(\d+)\s*\+?\s*(?:év|éves|ev|eves|years?|yrs?)/gi)) {
    const n = parseInt(m[1], 10);
    if (!Number.isNaN(n) && (max === null || n > max)) max = n;
  }
  return max;
}

export function isSeniorByYears(resolvedExperience) {
  if (CANONICAL_EXPERIENCE_LABELS.has(resolvedExperience)) return false;
  const years = parseMaxYears(resolvedExperience);
  return years !== null && years >= SENIOR_YEARS_THRESHOLD;
}

/* ── upsert (row fully built BEFORE insert — experience-write-policy) ── */

async function upsertJob(client, source, job, resolvedExperience) {
  await client.query(
    `INSERT INTO job_posts (source, title, url, experience, company, technologies, first_seen)
     VALUES ($1,$2,$3,$4,$5,$6,NOW())
     ON CONFLICT (source, url) DO UPDATE SET
        experience = CASE
          WHEN (job_posts.experience IS NULL OR job_posts.experience IN ('-', ''))
           AND EXCLUDED.experience NOT IN ('-', '')
          THEN EXCLUDED.experience ELSE job_posts.experience END,
        technologies = COALESCE(job_posts.technologies, EXCLUDED.technologies),
        company = CASE
          WHEN job_posts.company IS NULL THEN EXCLUDED.company
          ELSE job_posts.company END`,
    [source, job.title, job.url, resolvedExperience, job.company || null, job.technologies || null]
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
  let inserted = 0;
  let skippedSenior = 0;
  let skippedCompany = 0;
  let skippedNonIt = 0;

  for (const job of jobs) {
    if (!job || !job.title || !job.url) continue;
    foundUrls.push(job.url);
    if (!isItJob(job.title, categories)) { skippedNonIt++; continue; }
    if (isSeniorLike(job.title, filters)) { skippedSenior++; continue; }
    const resolvedExperience = resolveExperience(job);
    if (isSeniorByYears(resolvedExperience)) { skippedSenior++; continue; }
    if (isBlockedCompany(job.company, source)) { skippedCompany++; continue; }
    await upsertJob(client, source, job, resolvedExperience);
    inserted++;
  }

  let reconcile = { skipped: true };
  if (ok) {
    reconcile = await reconcileActive(client, source, foundUrls, { complete });
  }

  return { rows: jobs.length, inserted, skippedSenior, skippedCompany, skippedNonIt, ok, complete, reconcile };
}
