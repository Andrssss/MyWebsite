/*
  ATS MIX background scraper

  Goal:
    Stable ingestion from SmartRecruiters public posting API
    for companies with Budapest offices.
    Fetches list → filters HU → detail fetch per HU job for applyUrl.
*/

import { Pool } from "pg";
import { loadFilters } from "./load_filters.mjs";
import { withTimeout } from "./_error-logger.mjs";
import { reconcileActive, migrateVolatileUrl, escapeRegex } from "./_active_core.mjs";
import { extractBodyExperience, extractTechnologies, ensureTechnologiesColumn, isInternshipTitle, isSeniorExperience } from "./_experience_core.mjs";
import { shouldSkipTitleFilter, shouldSkipSeniorExperience, seniorAwareExperience } from "./_seniority_policy.mjs";

let _filters = [];

// jobs.smartrecruiters.com/{Company}/{id}-{slug} — the long numeric id ROTATES
// when the posting is refreshed (DB evidence: Wise backend-engineer-risk-…
// 744000133288855 → 744000134983949), so the url alone can't be the row
// identity. Pattern matches the same company+slug under any id.
function volatileUrlPattern(url) {
  const m = url.match(/^(https:\/\/jobs\.smartrecruiters\.com\/[^/]+\/)\d+-(.+)$/);
  return m ? `^${escapeRegex(m[1])}\\d+-${escapeRegex(m[2])}$` : null;
}

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

const SR_SOURCES = [
  { key: "wise",   company: "Wise",         label: "SmartRecruiters Wise" },
  { key: "roland", company: "RolandBerger", label: "SmartRecruiters Roland Berger" },
];

function normalizeWhitespace(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeUrl(raw) {
  try {
    const u = new URL(raw);
    u.hash = "";
    ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid", "oga"]
      .forEach((p) => u.searchParams.delete(p));
    return u.toString().replace(/\?$/, "");
  } catch {
    return raw;
  }
}

function _blacklistRegex(k) {
  const escaped = normalizeText(k).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i");
}

function isSeniorLike(title) {
  return shouldSkipTitleFilter(title, _filters);
}

function isHungaryLocation(loc) {
  if (!loc) return false;
  if (loc.country?.toLowerCase() === "hu") return true;
  const t = normalizeText(`${loc.city || ""} ${loc.fullLocation || ""}`);
  return t.includes("budapest") || t.includes("hungary") || t.includes("magyarorszag");
}

async function fetchJson(url) {
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "User-Agent": "JobWatcher/1.0",
      Accept: "application/json,text/plain;q=0.9,*/*;q=0.8",
      "Accept-Language": "hu-HU,hu;q=0.9,en;q=0.8",
    },
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }

  return res.json();
}

function extractSrDescription(detail) {
  const sections = detail?.jobAd?.sections;
  if (!sections) return null;
  return [sections.jobDescription?.text, sections.qualifications?.text]
    .filter(Boolean)
    .join(" ") || null;
}

// SmartRecruiters /postings caps a response at 100 items and pages via ?offset=N.
// A single limit=100 call only returns the first 100 postings — e.g. Wise has ~367
// and RolandBerger ~202, whose Budapest jobs sit past offset 100 — so we page until
// the full listing (totalFound) is fetched. Getting the complete set is what makes
// reconcileActive safe: a partial crawl would wrongly deactivate still-open jobs.
const SR_PAGE_SIZE = 100;
const SR_MAX_PAGES = 30; // safety cap (~3000 postings); totalFound normally stops sooner

async function fetchAllSrPostings(company) {
  const all = [];
  for (let page = 0; page < SR_MAX_PAGES; page += 1) {
    const offset = page * SR_PAGE_SIZE;
    const listUrl =
      `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(company)}/postings` +
      `?limit=${SR_PAGE_SIZE}&offset=${offset}`;
    const payload = await fetchJson(listUrl);
    const content = Array.isArray(payload?.content) ? payload.content : [];
    all.push(...content);

    const totalFound = Number(payload?.totalFound ?? 0);
    if (content.length < SR_PAGE_SIZE) break;          // short/last page
    if (totalFound && all.length >= totalFound) break; // fetched the whole listing
  }
  return all;
}

async function fetchSmartRecruiters(src) {
  const all = await fetchAllSrPostings(src.company);

  const nonHu = all.filter((it) => !isHungaryLocation(it?.location));
  const huItems = all.filter((it) => isHungaryLocation(it?.location));

  console.log(`[ats][${src.label}] total=${all.length} hu=${huItems.length} non-hu=${nonHu.length}`);
  if (nonHu.length > 0) {
    for (const it of nonHu) {
      const loc = it?.location;
      console.log(`[ats][${src.label}] skip non-HU: "${it.name}" → country=${loc?.country ?? "?"} city=${loc?.city ?? "?"}`);
    }
  }

  const results = [];
  for (const it of huItems) {
    const title = normalizeWhitespace(it.name);
    if (!title) {
      console.log(`[ats][${src.label}] skip no-title: id=${it.id}`);
      continue;
    }
    if (!it.ref) {
      console.log(`[ats][${src.label}] skip no-ref: "${title}"`);
      continue;
    }

    let applyUrl = null;
    let detail = null;
    try {
      detail = await fetchJson(it.ref);
      applyUrl = detail?.applyUrl || null;
      if (!applyUrl) {
        console.log(`[ats][${src.label}] skip no-applyUrl: "${title}" ref=${it.ref}`);
      }
    } catch (err) {
      console.error(`[ats][${src.label}] detail fetch failed for "${title}" (${it.id}): ${err.message}`);
    }

    if (!applyUrl) continue;

    const url = normalizeUrl(applyUrl);

    const descHtml = extractSrDescription(detail);
    let experience = isInternshipTitle(title) ? "diakmunka" : null;
    if (!experience) {
      experience = (descHtml ? extractBodyExperience(descHtml) : null) || "-";
    }
    const technologies = descHtml ? extractTechnologies(descHtml) : null;

    console.log(`[ats][${src.label}] ACCEPT: "${title}" exp=${experience} url=${url}`);
    // A cégnevet a SR-payload adja (`company.name`); a src.company csak az
    // API-slug, végszükség-tartalék.
    const company = normalizeWhitespace(it?.company?.name) || src.company || null;
    results.push({ source: src.key, title, url, experience, technologies, company });
  }

  return { raw: all.length, mapped: results };
}

function dedupeBySourceUrl(items) {
  const seen = new Set();
  const out = [];

  for (const item of items) {
    const key = `${item.source}::${normalizeUrl(item.url)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }

  return out;
}

/*
 * A `company` 2026-08-28-ig egyáltalán nem szerepelt az oszloplistában, pedig a
 * SmartRecruiters-payload adja — emiatt mind a 11 élő `wise` sor cégnév nélkül
 * állt. A DO UPDATE ág szándékosan CSAK NULL fölé ír (ugyanaz a guardolt
 * cég-backfill minta, mint a többi cégnevet író scraperben), így a meglévő
 * sorok maguktól begyógyulnak a következő futáson, és semmi mást nem írunk át.
 * A visszatérési érték `xmax = 0` — az "újonnan beszúrt" számláló különben a
 * backfill-frissítéseket is új sornak venné.
 */
async function upsertJob(client, item) {
  const res = await client.query(
    `INSERT INTO job_posts
      (source, title, url, experience, technologies, company, first_seen)
     VALUES ($1,$2,$3,$4,$5,$6,NOW())
     ON CONFLICT (source, url) DO UPDATE SET
        company = EXCLUDED.company
      WHERE job_posts.company IS NULL AND EXCLUDED.company IS NOT NULL
     RETURNING (xmax = 0) AS inserted;`,
    [item.source, item.title, item.url, seniorAwareExperience(item.title, item.experience) ?? "-", item.technologies ?? null, item.company ?? null]
  );
  return res.rows[0]?.inserted === true;
}

export default withTimeout("cron_jobs_ATS-background", async () => {
  _filters = await loadFilters();

  const client = await pool.connect();
  let fetchedRaw = 0;
  let candidates = 0;
  let skippedSenior = 0;
  let newlyInserted = 0;
  let alreadyExisted = 0;

  try {
    await ensureTechnologiesColumn(client);
    let anyFetchFailed = false;
    const foundBySource = new Map();
    const collected = [];

    for (const src of SR_SOURCES) {
      try {
        const { raw, mapped } = await fetchSmartRecruiters(src);
        fetchedRaw += raw;
        console.log(`[ats] ${src.label}: raw=${raw} hu_mapped=${mapped.length}`);
        collected.push(...mapped);
      } catch (err) {
        anyFetchFailed = true;
        console.error(`[ats] ${src.label} failed: ${err.message}`);
      }
    }

    const deduped = dedupeBySourceUrl(collected);
    candidates = deduped.length;

    // Full current listing per source (pre-senior-filter) — a url in this set is
    // live on the source, so migrateVolatileUrl must never rename its row away.
    const currentBySource = new Map();
    for (const item of deduped) {
      if (!currentBySource.has(item.source)) currentBySource.set(item.source, []);
      currentBySource.get(item.source).push(item.url);
    }

    for (const item of deduped) {
      if (shouldSkipTitleFilter(item.title, _filters) || shouldSkipSeniorExperience(isSeniorExperience(item.experience))) {
        console.log(`[ats] skip senior: "${item.title}" (${item.source})`);
        skippedSenior += 1;
        continue;
      }

      const pattern = volatileUrlPattern(item.url);
      if (pattern) {
        const migrated = await migrateVolatileUrl(
          client, item.source, item.url, pattern, currentBySource.get(item.source) || []
        );
        if (migrated) console.log(`[ats] MIGRATED url → ${item.url} (${item.source})`);
      }
      const wasNew = await upsertJob(client, item);
      if (wasNew) newlyInserted += 1;
      else alreadyExisted += 1;
      if (!foundBySource.has(item.source)) foundBySource.set(item.source, []);
      foundBySource.get(item.source).push(item.url);
    }

    console.log(
      `[ats] DONE - raw=${fetchedRaw}, candidates=${candidates}, new=${newlyInserted}, ` +
      `existed=${alreadyExisted}, skipped_senior=${skippedSenior}`
    );

    // Per-source reconcile, but only if every SmartRecruiters source loaded —
    // a failed source would otherwise look like "all its jobs vanished".
    if (!anyFetchFailed) {
      for (const [src, urls] of foundBySource) {
        const rc = await reconcileActive(client, src, urls, { complete: true });
        console.log(`[ats] active reconcile [${src}] — ${JSON.stringify(rc)}`);
      }
    } else {
      console.log(`[ats] active reconcile skipped — a source fetch failed`);
    }
  } finally {
    client.release();
  }

  return new Response("OK");
});
