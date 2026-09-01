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
  extractYearsFromText, isSeniorExperience, normalizeTechnologyList,
} from "./_experience_core.mjs";
import { shouldSkipTitleFilter, shouldSkipSeniorExperience, seniorAwareExperience } from "./_seniority_policy.mjs";
import { atsHandoff, registerAtsTenant } from "./_ats_handoff.mjs";
import { findCrossSourceDuplicates } from "./_ai_dupe_guard.mjs";

/* ── url/row normalization (shared by every caller-supplied write path) ──
   Lives here so ai-ingest.mjs and ai-registry.mjs can't drift apart on what
   counts as the same url — `url` IS the row identity for the ON CONFLICT
   upsert below, so two endpoints normalizing differently would silently
   create duplicate rows for one posting. */

const TRACKING = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid"];

// Single flat DB source for EVERY ai-scraped find (user decision 2026-07-21):
// one "AI-scraped" bucket instead of per-company `AI - <slug>` sources. The
// routine still tracks companies by slug in its registry memory, but the
// `job_posts.source` value is always this. (Legacy `AI - <slug>` rows were
// one-time collapsed into it via a migration in ai-registry.mjs, removed
// 2026-08-04 once confirmed none remained.)
export const AI_SOURCE = "AI-scraped";

export function toSlug(s) {
  return String(s || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function normalizeUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    // Fragment is KEPT (not stripped) — some career sites (e.g. KNBSZ,
    // 2026-07-31) render every posting as its own #anchor section on one
    // single-page listing with no separate server-rendered URL per job. The
    // fragment is the only thing that makes those postings distinct rows.
    // Safe pipeline-wide: none of the ~30 hand scrapers produce URLs with a
    // hash component, so this only changes behavior for sites shaped like
    // KNBSZ, never for existing sources.
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
      // The LLM writes free text here with no other filtering (unlike every
      // hand scraper, which only ever stores extractTechnologies() output) —
      // normalize down to recognized TECH_KEYWORDS labels only, or this
      // pipeline keeps reintroducing the exact noise the 2026-08-06 cleanup
      // removed (see the "AI-scraped technologies cleanup" memory).
      technologies: normalizeTechnologyList(j.technologies),
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

/* ── "erős" IT-cím jel (a kategória-taxonómia MELLÉ, nem helyette) ──
   Akkor kell, ha a forrás saját kategóriája nem megbízható: van olyan portál,
   ahol egy IT hirdetés nem-IT kategóriában ül (muisz "IT Intern" → Irodai,
   melodiak → gazdasagi-penzugyi-marketing slug). Ilyenkor a kategória-szűrő
   tágítása NEM megoldás — a 2026-07-29-i muisz kat.4 eset (a teljes Mérnöki
   kategória beöntése) és a `job_categories` teljes keyword-listája is tömeg
   fals pozitívot hoz ("Office manager assistant", "Kontroller gyakornok",
   "Robotporszívó-tesztelő"). Ezért a nem-IT kategóriákból CSAK egyértelmű
   IT-jelre engedünk be.

   Szándékosan NINCS benne a puszta "tesztelő" / "elemző" / "admin" / "manager" /
   "kontroller" — pont ezek a fenti fals pozitívok forrásai. Az `isItJob`-tól
   (job_categories teljes keyword-listája) külön él és szűkebb nála: ez a
   kategórián KÍVÜLI beengedés kapuja, az `isItJob` a kategória nélküli
   forrásoké.

   Egy közös példány, mert két scraper használja (melodiak, muisz) — külön
   másolatban garantáltan szétcsúsznának. */
export const STRONG_IT_TITLE =
  /(adattudós|adatelemző|adatmérnök|data\s+(scientist|analyst|engineer)|szoftver|software|programozó|fejlesztőmérnök|webfejlesztő|developer|devops|rendszergazda|informatikus|\bIT\b)/i;

export function hasStrongItTitle(title) {
  return STRONG_IT_TITLE.test(String(title || ""));
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
  return shouldSkipTitleFilter(title, filters);
}

/* ── location filter (user rule 2026-07-24: default Budapest-only) ──
   AI-scraped targets ANY Hungarian company's career page, unlike the hand
   scrapers which mostly already skew Budapest. `job.location` is free text
   the routine itself reads off the posting (see AI_SITES.md / the trigger
   prompt) — deterministic keyword check here is a backstop matching the
   isSeniorLike pattern above, NOT the primary decision (the routine is
   expected to already skip clearly-non-Budapest postings before submitting,
   per the trigger prompt's filter 6).
   Trigger case: karrier.4iggroup.hu "Szeged - Hálózat üzemeltető" got saved
   with no location awareness at all — the field existed in the schema but
   was silently discarded before this fix, never gating anything.
   Rule: reject ONLY when the location is a clearly stated OTHER place with no
   Budapest/remote/nationwide qualifier anywhere in the string. Empty/missing
   location (not clearly stated) is kept, per explicit user instruction. */

const LOCATION_OK_HINTS = [
  "budapest", "bp.", "bp,", "remote", "tavmunka", "home office", "homeoffice",
  "orszagos", "magyarorszag", "hungary", "barhol",
];

export function isNonBudapestLocation(location) {
  const n = normalizeText(location);
  if (!n) return false; // not clearly stated → keep (user rule)
  return !LOCATION_OK_HINTS.some((hint) => n.includes(hint));
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

// Senior postings are stored and are hidden by default in the frontend.  Keep
// the policy gate here so the source-specific title/experience classifiers
// remain available without dropping the row before upsert.

/* ── upsert (row fully built BEFORE insert — experience-write-policy) ── */

async function upsertJob(client, source, job, resolvedExperience) {
  // AI-scraped postings used to start hidden pending human review
  // (job-hidden.js un-hide) before reaching the public board — removed
  // 2026-08-15 (user decision): the routine's own 6-filter vetting is now
  // trusted to gate quality directly, so new AI findings go live immediately.
  // `hidden` is deliberately absent from the ON CONFLICT SET below: once a row
  // exists, a re-ingest (the same posting found again on a later run) must
  // never re-hide it or re-clobber an admin's un-hide decision — same
  // anti-clobber policy already used here for `experience`.
  const startsHidden = false;
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
          ELSE job_posts.company END
        WHERE ((job_posts.experience IS NULL OR job_posts.experience IN ('-', ''))
               AND EXCLUDED.experience NOT IN ('-', ''))
           OR (job_posts.technologies IS NULL AND EXCLUDED.technologies IS NOT NULL)
           OR (job_posts.company IS NULL AND EXCLUDED.company IS NOT NULL)`,
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
 * @param {(location: string) => boolean} [args.rejectLocation=isNonBudapestLocation]
 *                                    location gate; true = skip the row. Overridable because
 *                                    the ATS crawl needs the OPPOSITE default for a missing
 *                                    location (fail-closed — an international job board is
 *                                    foreign unless it says otherwise; see _ats_location.mjs).
 *                                    Injected rather than branching on `source` here so this
 *                                    module keeps knowing nothing about its callers.
 * @param {string}   [args.scopePrefix]  passed through to reconcileActive — restricts its
 *                                    writes to rows under one url prefix. Required when many
 *                                    independent full listings share ONE source value.
 * @param {boolean} [args.skipCrossSourceDupes=false]  AI-callers only. A candidate whose
 *                                    (title, company) already exists as an ACTIVE row under a
 *                                    DIFFERENT source is dropped instead of inserted — the same
 *                                    role-separation idea as handoffAtsUrls, one level up
 *                                    (_ai_dupe_guard.mjs). Opt-in for the same reason: ats-crawl and
 *                                    workable own their sources' full listings and must not skip
 *                                    rows just because another scraper also sees them.
 * @param {boolean} [args.handoffAtsUrls=false]  AI-callers only. An incoming url that resolves to a
 *                                    known ATS board is NOT inserted; the tenant behind it is
 *                                    registered instead and ats-crawl harvests the whole board
 *                                    (_ats_handoff.mjs has the full reasoning). Deliberately
 *                                    opt-in: ats-crawl and workable post ATS urls themselves and
 *                                    must never hand their own rows away.
 */
export async function ingestJobs(client, {
  source, jobs, fullListing = false, filters = [], categories = [],
  rejectLocation = isNonBudapestLocation, scopePrefix = null, handoffAtsUrls = false,
  skipCrossSourceDupes = false,
}) {
  await ensureTechnologiesColumn(client);
  const ok = jobs.length > 0;
  const complete = ok && !!fullListing;

  const foundUrls = []; // FULL pre-filter set → a filter change can't deactivate a live job (F3).
  const insertedUrls = []; // Only rows that passed every gate — callers use this to record what
                           // actually reached the DB, rather than what they hoped to write.
  let skippedSenior = 0;
  let skippedCompany = 0;
  let skippedNonIt = 0;
  let skippedLocation = 0;
  // ATS-átadás könyvelése (csak handoffAtsUrls mellett mozdul).
  const handedToAtsUrls = []; // ezekből tenant lesz, sor nem
  const skippedLegacyAtsUrls = []; // ezeket már egy másik scraper hozza
  /** @type {Map<string, {provider:string, slug:string, company:string|null}>} */
  const atsTenants = new Map();
  // Kereszt-forrás duplikátumok (_ai_dupe_guard.mjs) — egy lekérés az egész
  // kötegre, a cikluson KÍVÜL.
  const skippedDuplicateUrls = [];
  const duplicateOf = [];
  const dupes = skipCrossSourceDupes
    ? await findCrossSourceDuplicates(client, source, jobs)
    : new Map();

  for (const job of jobs) {
    if (!job || !job.title || !job.url) continue;
    // foundUrls a szűrés ELŐTTI halmaz, és az átadott url-ek is benne maradnak:
    // különben a reconcile "eltűntnek" látná őket, és deaktiválná a még élő
    // AI-sort, amit épp az ats-crawl-nak adunk át.
    foundUrls.push(job.url);
    // Az átadás a tartalmi kapuk ELŐTT dől el: a lead maga a BOARD, nem ez az
    // egy hirdetés — egy nem-IT találat mögött is lehet olyan cég, akinek a
    // boardján IT-állás van. A hirdetés-szintű szűrést az ats-crawl végzi el a
    // saját körében.
    if (handoffAtsUrls) {
      const handoff = atsHandoff(job.url);
      if (handoff) {
        if (handoff.kind === "legacy") {
          skippedLegacyAtsUrls.push(job.url);
        } else {
          handedToAtsUrls.push(job.url);
          const key = `${handoff.provider}:${handoff.slug}`;
          if (!atsTenants.has(key)) {
            atsTenants.set(key, { provider: handoff.provider, slug: handoff.slug, company: job.company || null });
          }
        }
        continue;
      }
    }
    // Amit egy meglévő forrás MÁR behozott (aktív sorként), azt nem szúrjuk be
    // másodszor egy másik url alatt — az AI dolga a felderítés, nem az
    // újraaratás (_ai_dupe_guard.mjs fejléc: BKK "BI elemző", 2026-09-01).
    const dupe = dupes.get(job.url);
    if (dupe) {
      skippedDuplicateUrls.push(job.url);
      duplicateOf.push({ url: job.url, title: job.title, existingSource: dupe.source, existingUrl: dupe.url });
      continue;
    }
    if (!isItJob(job.title, categories)) { skippedNonIt++; continue; }
    if (shouldSkipTitleFilter(job.title, filters)) { skippedSenior++; continue; }
    if (rejectLocation(job.location)) { skippedLocation++; continue; }
    const resolvedExperience = seniorAwareExperience(job.title, resolveExperience(job));
    if (shouldSkipSeniorExperience(isSeniorExperience(resolvedExperience))) { skippedSenior++; continue; }
    if (isBlockedCompany(job.company, source)) { skippedCompany++; continue; }
    await upsertJob(client, source, job, resolvedExperience);
    insertedUrls.push(job.url);
  }

  // Tenant-felvétel a ciklus UTÁN, csoportosítva: egy boardról tíz hirdetés is
  // jöhet, tenant-írás viszont csak egy kell belőle.
  const atsTenantsAdded = [];
  for (const t of atsTenants.values()) {
    try {
      if (await registerAtsTenant(client, { ...t, via: "ai-handoff" })) {
        atsTenantsAdded.push(`${t.provider}:${t.slug}`);
      }
    } catch (err) {
      // Az átadás már megtörtént (a sort nem szúrtuk be), tehát a lead elveszne
      // — ezért ez hangosan naplózódik, nem csendben nyelődik el.
      console.error(`[${source}] ats-tenant handoff FAILED for ${t.provider}:${t.slug}: ${err.message}`);
    }
  }

  let reconcile = { skipped: true };
  if (ok) {
    reconcile = await reconcileActive(client, source, foundUrls, { complete, scopePrefix });
  }

  return {
    rows: jobs.length, inserted: insertedUrls.length, insertedUrls,
    skippedSenior, skippedCompany, skippedNonIt, skippedLocation, ok, complete, reconcile,
    handedToAts: handedToAtsUrls.length, handedToAtsUrls,
    skippedLegacyAts: skippedLegacyAtsUrls.length,
    atsTenantsAdded,
    skippedDuplicate: skippedDuplicateUrls.length, skippedDuplicateUrls, duplicateOf,
  };
}
