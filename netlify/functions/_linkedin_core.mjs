import { Pool } from "pg";
import https from "https";
import http from "http";
import zlib from "zlib";
import { load as cheerioLoad } from "cheerio";
import { loadFilters } from "./load_filters.mjs";
import { isBlockedCompany } from "./_company_blocklist.mjs";
import {
  INTERNSHIP_KEYWORDS, isInternshipTitle, isJuniorTitle, isMidLevelTitle,
  extractLinkedInExperience, extractTechnologies, ensureTechnologiesColumn,
} from "./_experience_core.mjs";
import { shouldSkipTitleFilter, seniorAwareExperience } from "./_seniority_policy.mjs";
import { loadSameSourceDupeIndex, findSameSourceDuplicate } from "./_active_core.mjs";
import { dupeKey } from "../../src/lib/crossSourceDupe.mjs";

let _filters = [];

// =====================
// DB
// =====================
const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

// =====================
// HELPERS
// =====================
function normalizeText(s) {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function hasLatinScript(title, minLetters = 2) {
  return (normalizeText(title).match(/[a-z]/g) || []).length >= minLetters;
}

// INTERNSHIP_KEYWORDS / isInternshipTitle imported from _experience_core.mjs

function _blacklistRegex(k) {
  const escaped = normalizeText(k).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i");
}

function titleNotBlacklisted(title) {
  return !shouldSkipTitleFilter(title, _filters);
}

function dedupeByUrl(items) {
  const seen = new Set();
  return items.filter((x) => {
    if (!x.url) return false;
    const key = getDedupeKey(x.url);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function randomDelay(minMs = 600, maxMs = 1400) {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise(resolve => setTimeout(resolve, ms));
}

// LinkedIn guest pagination endpoint. NOTE: it does NOT return the same
// structure as the public search page — it sends a bare <li> fragment with no
// <ul> wrapper, so `ul.jobs-search__results-list li` matches nothing there
// (see extractLinkedInJobs).
const LINKEDIN_GUEST_PAGINATION_URL =
  "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search";
// The fragment endpoint returns 10 results per call, NOT the 25 the search
// page's own paging suggests (verified live: start=25 -> rows 26-35,
// start=35 -> rows 36-45). Stepping by 25 skipped 15 rows out of every 25.
const LINKEDIN_PAGE_SIZE = 10;

// =====================
// Bot-evasion helpers
// =====================
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0",
];

function pickUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// Custom error class so processLinkedInSources can detect a hard ban
// and abort the entire cron run instead of hammering further.
class LinkedInBlockedError extends Error {
  constructor(status, url) {
    super(`LinkedIn blocked request (HTTP ${status}) for ${url}`);
    this.name = "LinkedInBlockedError";
    this.status = status;
  }
}

// =====================
// URL helpers
// =====================
function normalizeUrl(raw) {
  try {
    const u = new URL(raw);

    if (u.hostname.includes("linkedin.com") && u.pathname.startsWith("/jobs/view/")) {
      return `https://${u.hostname}${u.pathname}`;
    }

    u.hash = "";
    [
      "utm_source","utm_medium","utm_campaign","utm_term",
      "utm_content","fbclid","gclid","trackingId","pageNum","position","refId"
    ].forEach(p => u.searchParams.delete(p));

    return u.toString().replace(/\?$/, "");
  } catch {
    return raw;
  }
}

// =====================
// Fetch helper
// =====================
function fetchText(url, opts = {}, redirectLeft = 5) {
  // opts: { userAgent, referer } — kept for signature compatibility, ignored
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;

    const req = lib.request(
      u,
      {
        method: "GET",
        headers: {
          "User-Agent": "JobWatcher/1.0",
          Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
          "Accept-Language": "hu-HU,hu;q=0.9,en;q=0.8",
          "Accept-Encoding": "gzip,deflate,br",
        },
        timeout: 25000,
      },
      (res) => {
        const code = res.statusCode || 0;

        if ([301,302,303,307,308].includes(code)) {
          const loc = res.headers.location;
          if (!loc) return reject(new Error(`HTTP ${code} (no Location) for ${url}`));
          if (redirectLeft <= 0) return reject(new Error(`Too many redirects for ${url}`));
          const nextUrl = new URL(loc, url).toString();
          res.resume();
          return resolve(fetchText(nextUrl, opts, redirectLeft - 1));
        }

        // Hard block / rate limit signals from LinkedIn
        if (code === 429 || code === 999 || code === 403) {
          res.resume();
          return reject(new LinkedInBlockedError(code, url));
        }

        const enc = String(res.headers["content-encoding"] || "").toLowerCase();
        let stream = res;
        if (enc.includes("gzip")) stream = res.pipe(zlib.createGunzip());
        else if (enc.includes("deflate")) stream = res.pipe(zlib.createInflate());
        else if (enc.includes("br")) stream = res.pipe(zlib.createBrotliDecompress());

        let data = "";
        stream.setEncoding("utf8");
        stream.on("data", (chunk) => data += chunk);
        stream.on("end", () => {
          if (code >= 200 && code < 300) resolve(data);
          else reject(new Error(`HTTP ${code} for ${url}`));
        });
        stream.on("error", reject);
      }
    );

    req.on("timeout", () => req.destroy(new Error(`Timeout for ${url}`)));
    req.on("error", reject);
    req.end();
  });
}

// =====================
// LinkedIn extraction
// =====================
function extractLinkedInJobs(html) {
  const $ = cheerioLoad(html);
  const jobs = [];

  // Bare `li` on purpose: the seeMoreJobPostings fragment arrives without a
  // <ul> wrapper, so `ul.jobs-search__results-list li` matched 0 there and
  // every search silently stopped after page 0. The `title && url` guard below
  // drops the non-result <li>s (nav etc.); on page 0 both selectors yield the
  // same 60 hits.
  $("li").each((_, el) => {
    const title = normalizeText($(el).find("h3.base-search-card__title").text());
    const company = normalizeText($(el).find("h4.base-search-card__subtitle").text());
    let location = normalizeText($(el).find("span.job-search-card__location").text());
    if (!location) location = normalizeText($(el).text());
    const url = $(el).find("a.base-card__full-link").attr("href");
    if (title && url) jobs.push({ title, url, company, location });
  });

  return dedupeByUrl(jobs);
}

// The trailing numeric segment in /jobs/view/{slug}-{id} is LinkedIn's own
// stable job posting id; the slug text ahead of it is editable SEO copy the
// poster can change without the id changing. This used to canonicalize on
// the SLUG (stripping the id) — backwards: confirmed live 2026-09-04, 12
// duplicate pairs where the SAME numeric id got a different slug on a title
// edit (gammaorg "ot cybersecurity engineer" -> "it/ot cybersecurity
// engineer", both id 4460343194; cushman, waterbear, betsson, bluebird, smp,
// mbh, noventiq and others) — the old canonical differed even though it was
// the identical posting, so both the canonical_url check AND the title-keyed
// sameSourceDupeIndex (title also changed) missed it. Canonicalize on the id
// instead. Falls back to the old slug-based value when there's no trailing
// numeric id to anchor on (keeps existing behavior for any URL shape that
// doesn't match).
function canonicalizeLinkedInJobUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.hostname.includes("linkedin.com") && u.pathname.startsWith("/jobs/view/")) {
      const lastPart = u.pathname.split("/jobs/view/")[1];
      const idMatch = lastPart.match(/-(\d+)\/?$/);
      if (idMatch) {
        return `https://www.linkedin.com/jobs/view/${idMatch[1]}`;
      }
      const canonicalSlug = lastPart.replace(/-\d+$/, "");
      return `https://www.linkedin.com/jobs/view/${canonicalSlug}`;
    }
    return raw;
  } catch {
    return raw;
  }
}

function getDedupeKey(rawUrl) {
  const u = normalizeUrl(rawUrl);
  if (u.includes("linkedin.com/jobs/view/")) return canonicalizeLinkedInJobUrl(u);
  return u;
}

function isHungarianLinkedInUrl(rawUrl) {
  try {
    return new URL(rawUrl).hostname.toLowerCase() === "hu.linkedin.com";
  } catch {
    return false;
  }
}

// Title-only guess, used both as the insert-time fallback (fetch failed/
// skipped) and to decide whether a detail-page fetch can even improve on it.
function inferTitleExperience(title) {
  if (isInternshipTitle(title)) return "diákmunka";
  if (isJuniorTitle(title)) return "junior";
  if (isMidLevelTitle(title)) return "medior";
  return "-";
}

// =====================
// DB upsert
// =====================
// Row must be fully built (title-or-fetched experience + technologies)
// BEFORE this runs — no separate later pass patches it in (user rule,
// 2026-09-02: this used to be LinkedIn's one allowed exception).
async function upsertJob(client, source, item) {
  const canonicalUrl =
    source === "LinkedIn"
      ? canonicalizeLinkedInJobUrl(item.url)
      : item.url;
  const experience = seniorAwareExperience(item.title, item.experience ?? inferTitleExperience(item.title));

  await client.query(
    `INSERT INTO job_posts
      (source, title, url, canonical_url, experience, company, technologies, first_seen)
     SELECT $1,$2,$3,$4,$5,$6,$7,NOW()
     WHERE NOT EXISTS (
       SELECT 1 FROM job_posts WHERE source = $1 AND canonical_url = $4
     )
     ON CONFLICT (source, url)
        DO NOTHING;
        `,
    [source, item.title, item.url, canonicalUrl, experience, item.company || null, item.technologies ?? null]
  );
}

function levelNotBlacklisted(title, desc) {
  return !shouldSkipTitleFilter(title, _filters);
}

// =====================
// Pagination (opt-in via source.paginate = true)
// =====================
function buildLinkedInPageUrl(searchUrl, start) {
  // Reuse the keywords/geoId/location/etc. params from the original search URL
  // and call the guest "seeMore" endpoint with start=N.
  const orig = new URL(searchUrl);
  const out = new URL(LINKEDIN_GUEST_PAGINATION_URL);
  for (const [k, v] of orig.searchParams.entries()) {
    out.searchParams.set(k, v);
  }
  out.searchParams.set("start", String(start));
  return out.toString();
}

async function fetchAllLinkedInPages(searchUrl, {
  maxPages = 5,
  minDelayMs = 8000,
  maxDelayMs = 15000,
  userAgent,
} = {}) {
  const all = [];
  // Use one UA per source so all pages of one search look like one browser
  // session (real users keep the same UA when scrolling).
  const ua = userAgent || pickUserAgent();
  const referer = "https://www.linkedin.com/jobs/search/";

  // Page 0: the normal search page (returns full HTML with the same list).
  const firstHtml = await fetchText(searchUrl, { userAgent: ua, referer });
  const firstItems = extractLinkedInJobs(firstHtml);
  all.push(...firstItems);

  // If first page already empty, no point paging.
  if (firstItems.length === 0) return dedupeByUrl(all);

  for (let page = 1; page < maxPages; page++) {
    // Delay BEFORE every page (incl. first paginated one) — humans don't
    // scroll instantly after the page renders.
    await randomDelay(minDelayMs, maxDelayMs);
    // Page 0 is the full search page and already returned `firstItems.length`
    // rows (60 in a live check), so continue right after them instead of
    // assuming page 0 held one LINKEDIN_PAGE_SIZE worth. The post-dedupe
    // length can only undershoot the real row count, and an overlap is
    // harmless (dedupeByUrl) while a gap would silently drop postings.
    const start = firstItems.length + (page - 1) * LINKEDIN_PAGE_SIZE;
    const pageUrl = buildLinkedInPageUrl(searchUrl, start);
    let html;
    try {
      html = await fetchText(pageUrl, { userAgent: ua, referer: searchUrl });
    } catch (err) {
      if (err instanceof LinkedInBlockedError) throw err; // bubble up — abort cron
      console.error(`pagination stop at start=${start}: ${err.message}`);
      break;
    }
    const items = extractLinkedInJobs(html);
    if (items.length === 0) break;
    all.push(...items);
  }

  return dedupeByUrl(all);
}

// =====================
// Main processing function
// =====================
export async function processLinkedInSources(sources, jobName) {
  if (String(process.env.LINKEDIN_DISABLED || "").toLowerCase() === "true") {
    console.warn(`${jobName}: LINKEDIN_DISABLED=true — skipping run.`);
    return new Response("DISABLED");
  }

  _filters = await loadFilters();

  const client = await pool.connect();
  let blocked = false;

  try {
    await ensureTechnologiesColumn(client);

    // Known canonical urls for the whole run — a genuinely new posting gets
    // its detail page fetched once, right here, before it's ever inserted;
    // an already-known one is never re-fetched (see upsertJob's WHERE NOT
    // EXISTS — inserting for it would be a no-op anyway). Updated in-memory
    // as we go so the same new posting surfacing under two search shards in
    // one run only gets fetched once.
    const { rows: knownRows } = await client.query(
      `SELECT canonical_url FROM job_posts WHERE source = 'LinkedIn' AND canonical_url IS NOT NULL`
    );
    const knownCanonicalUrls = new Set(knownRows.map(r => r.canonical_url));

    // Broader same-posting guard, on top of the canonical_url check above —
    // canonicalizeLinkedInJobUrl only strips the trailing numeric id, so it
    // misses a re-post whose SLUG TEXT itself changed (company name variant,
    // "front-end" vs "frontend" spelling). Confirmed live 2026-09-03: 8 such
    // duplicate pairs. Built once here, updated as we go so a second
    // near-duplicate discovered later in this SAME run is also caught (the
    // Innoview lesson — see pestidev-job-scraper PR #14).
    const sameSourceDupeIndex = await loadSameSourceDupeIndex(client, "LinkedIn");

    for (const p of sources) {
      if (blocked) {
        console.warn(`${jobName}: aborting remaining sources after LinkedIn block.`);
        break;
      }
      await randomDelay(2000, 5000); // longer pause between sources
      const ua = pickUserAgent();
      let rawItems;
      try {
        if (p.paginate) {
          rawItems = await fetchAllLinkedInPages(p.url, {
            maxPages: p.maxPages ?? 5,
            userAgent: ua,
          });
        } else {
          const html = await fetchText(p.url, { userAgent: ua });
          rawItems = extractLinkedInJobs(html);
        }
      } catch (err) {
        if (err instanceof LinkedInBlockedError) {
          console.error(`${jobName}: BLOCKED by LinkedIn (HTTP ${err.status}) at ${p.url} — aborting cron run.`);
          blocked = true;
          continue;
        }
        console.error(p.key, "fetch failed:", err.message);
        continue;
      }

      let items = rawItems.filter(it => {
        if (!hasLatinScript(it.title)) return false;
        if (!levelNotBlacklisted(it.title, it.description)) return false;
        if (!titleNotBlacklisted(it.title)) return false;
        if (isBlockedCompany(it.company, p.key)) return false;
        if (!isHungarianLinkedInUrl(it.url) && (!it.location || (!it.location.includes("budapest") && !it.location.includes("hungary")))) return false;
        return true;
      });

      for (const it of items) {
        const canonical = canonicalizeLinkedInJobUrl(it.url);
        it.experience = inferTitleExperience(it.title);

        // New posting: fetch its detail page ONCE, right now, so experience
        // (if the title alone didn't already resolve it) and technologies
        // land in the row before it's ever inserted — no later backfill pass.
        if (!knownCanonicalUrls.has(canonical)) {
          try {
            await randomDelay();
            const html = await fetchText(it.url, { userAgent: ua });
            if (it.experience === "-") it.experience = extractLinkedInExperience(html) || "-";
            it.technologies = extractTechnologies(html);
          } catch (err) {
            if (err instanceof LinkedInBlockedError) {
              console.error(`${jobName}: BLOCKED by LinkedIn (HTTP ${err.status}) fetching detail ${it.url} — aborting cron run.`);
              blocked = true;
              break;
            }
            console.warn(`[LinkedIn] detail fetch failed: ${it.url} — ${err.message}`);
          }
          knownCanonicalUrls.add(canonical);
        }

        // A detail fetch that comes back with NEITHER experience NOR
        // technologies means something went wrong getting the real page —
        // confirmed live 2026-09-04 (Tesco "Software Development Engineer
        // III"): NOT a LinkedIn login-wall (re-fetching the identical url
        // moments later returned the full 5.7k-char description and a
        // complete tech list — same one the sibling posting already had
        // stored), so most likely a one-off network hiccup/timeout on that
        // specific request. The block-detector (LinkedInBlockedError above)
        // only watches for 429/999/403, so a plain transient failure — or a
        // technically-200 response that's short/incomplete for some other
        // reason — sails right through uncaught. Previously this got
        // inserted anyway, permanently incomplete — there is no backfill
        // pass to fix it later (experience-write-policy memory). Skip it
        // instead; it's simply re-attempted whenever the listing surfaces it
        // again on a later run. Re-evaluated per item, so a duplicate
        // canonical url seen again via another search shard in this SAME run
        // is caught too, without needing separate tracking. Accepted
        // tradeoff: a genuinely real posting whose body names zero
        // recognizable tech AND zero experience language also gets skipped —
        // user decision 2026-09-04, prefers that over a permanently
        // half-empty row.
        if (!it.technologies && it.experience === "-") {
          console.log(`[LinkedIn] SKIP incomplete detail fetch (no tech, no experience) — retry later: ${it.url}`);
          continue;
        }

        const dupe = findSameSourceDuplicate(sameSourceDupeIndex, it.url, it.company, it.title, it.technologies);
        if (dupe) {
          console.log(`[LinkedIn] SKIP same-source dupe "${it.title}" @ ${it.company || "-"} — already active at ${dupe.url}`);
          continue;
        }

        try {
          await upsertJob(client, p.key, it);
          // Seed the index with this item too, so a second near-duplicate
          // discovered later in THIS run (different search shard, same real
          // posting) is caught as well — not just ones already in the DB.
          const key = dupeKey(it.company, it.title);
          if (key) {
            if (!sameSourceDupeIndex.has(key)) sameSourceDupeIndex.set(key, []);
            sameSourceDupeIndex.get(key).push({ url: it.url, technologies: it.technologies });
          }
        } catch (err) {
          console.error(err);
        }
      }

      console.log(`${p.key}: ${items.length} items processed.`);
    }

  } finally {
    console.log(`Script finished at ${new Date().toISOString()}${blocked ? " (ABORTED: LinkedIn block)" : ""}`);
    client.release();
  }

  return new Response(blocked ? "BLOCKED" : "OK");
}
