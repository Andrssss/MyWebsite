/* =========================
  "https://hu.talent.com,
*/



import { Pool } from "pg";
import https from "https";
import http from "http";
import zlib from "zlib";
import { load as cheerioLoad } from "cheerio";
import { loadFilters } from "./load_filters.mjs";
import { logFetchError, withTimeout } from "./_error-logger.mjs";
import { reconcileActive } from "./_active_core.mjs";
import { isBlockedCompany, purgeBlockedCompanies } from "./_company_blocklist.mjs";
import { extractTalentExperience, extractTechnologies, INTERNSHIP_KEYWORDS } from "./_experience_core.mjs";

let _filters = [];

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

// NO &date=1 filter: we want the widest listing per keyword — for ingest
// breadth and so the reactivate-only reconcile can heal live rows that rotate
// back into the search. (&date=1 also returns near-empty results nowadays.)
// We fetch the whole list and let ON CONFLICT DO NOTHING dedupe.
const TALENT_SEARCH_URLS = [
  "https://hu.talent.com/jobs?k=fejleszt%C5%91&l=Budapest%2C+HU",
  "https://hu.talent.com/jobs?k=programoz%C3%B3&l=Budapest%2C+HU",
  "https://hu.talent.com/jobs?k=tesztel%C5%91&l=Budapest%2C+HU",
  "https://hu.talent.com/jobs?k=tester&l=Budapest%2C+HU",
  "https://hu.talent.com/jobs?k=programmer&l=Budapest%2C+HU",
  "https://hu.talent.com/jobs?k=developer&l=Budapest%2C+HU",
  "https://hu.talent.com/jobs?k=qa&l=Budapest%2C+HU",
  "https://hu.talent.com/jobs?k=data&l=Budapest%2C+HU",
  "https://hu.talent.com/jobs?k=devops&l=Budapest%2C+HU",
  "https://hu.talent.com/jobs?k=hardware&l=Budapest%2C+HU",
  "https://hu.talent.com/jobs?k=support&l=Budapest%2C+HU",
  "https://hu.talent.com/jobs?k=c%2B%2B&l=Budapest%2C+HU",
];

/* ── shared helpers ─────────────────────────────────────────── */

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
    const url = new URL(raw);
    url.hash = "";
    ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid"].forEach((key) =>
      url.searchParams.delete(key)
    );
    return url.toString().replace(/\?$/, "");
  } catch {
    return raw;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fetchText(url, redirectLeft = 5) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const lib = parsedUrl.protocol === "https:" ? https : http;

    const req = lib.request(
      parsedUrl,
      {
        method: "GET",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
          "Accept-Language": "hu-HU,hu;q=0.9,en;q=0.8",
          "Accept-Encoding": "gzip,deflate,br",
        },
        timeout: 25000,
      },
      (res) => {
        const code = res.statusCode || 0;

        if ([301, 302, 303, 307, 308].includes(code)) {
          const location = res.headers.location;
          if (!location) return reject(new Error(`HTTP ${code} (no Location) for ${url}`));
          if (redirectLeft <= 0) return reject(new Error(`Too many redirects for ${url}`));
          const nextUrl = new URL(location, url).toString();
          res.resume();
          return resolve(fetchText(nextUrl, redirectLeft - 1));
        }

        const encoding = String(res.headers["content-encoding"] || "").toLowerCase();
        let stream = res;

        if (encoding.includes("gzip")) stream = res.pipe(zlib.createGunzip());
        else if (encoding.includes("deflate")) stream = res.pipe(zlib.createInflate());
        else if (encoding.includes("br")) stream = res.pipe(zlib.createBrotliDecompress());

        let body = "";
        stream.setEncoding("utf8");
        stream.on("data", (chunk) => {
          body += chunk;
        });
        stream.on("end", () => {
          if (code >= 200 && code < 300) resolve(body);
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

async function upsertJob(client, sourceKey, item) {
  await client.query(
    `INSERT INTO job_posts
      (source, title, url, experience, company, technologies, first_seen)
     VALUES ($1,$2,$3,$4,$5,$6,NOW())
     ON CONFLICT (source, url)
       DO NOTHING
    `,
    [sourceKey, item.title, item.url, item.experience, item.company || null, item.technologies ?? null]
  );
}

/* ── talent.com ─────────────────────────────────────────────── */

function _blacklistRegex(k) {
  const escaped = normalizeText(k).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i");
}

function isSeniorLike(title) {
  const normalized = normalizeText(title);
  return _filters.some((kw) => _blacklistRegex(kw).test(normalized));
}

// INTERNSHIP_KEYWORDS / isInternshipTitle imported from _experience_core.mjs

function inferTalentExperience(title) {
  const normalized = normalizeText(title);
  if (INTERNSHIP_KEYWORDS.some(k => normalized.includes(k))) return "diákmunka";
  if (/\bmedior\b|\bmid\b/.test(normalized)) return "medior";
  if (/\bjunior\b|\bpalyakezdo\b|\bentry.?level\b/.test(normalized))
    return "junior";
  return null;
}

const TALENT_MAX_PAGES = 30;

// NOTE: no text-based "no results" check. talent.com is a Next.js SPA that ships
// the "nincsenek találatok" / "Már nem fogadnak jelentkezéseket" strings in its
// i18n dictionary on EVERY page, so matching them yields false positives. We stop
// paging on an empty extraction (jobs.length === 0) instead.

function buildTalentPagedUrl(baseUrl, page) {
  const u = new URL(baseUrl);
  if (page > 1) u.searchParams.set("p", String(page));
  else u.searchParams.delete("p");
  return u.toString();
}

function extractTalentJobs(html) {
  const $ = cheerioLoad(html);
  const jobs = [];
  const seen = new Set();

  $("h2").each((_i, el) => {
    const $h2 = $(el);
    const title = normalizeWhitespace($h2.text());
    if (!title) return;

    let viewHref = null;
    let company = null;
    let $card = $h2;
    for (let j = 0; j < 8; j++) {
      $card = $card.parent();
      if (!viewHref) {
        const link = $card.find('a[href*="/view?id="]').first();
        if (link.length) viewHref = link.attr("href");
      }
      if (!company) {
        const c = $card.find('[class*="JobCard_company"]').first();
        if (c.length) company = normalizeWhitespace(c.text()) || null;
      }
      if (viewHref && company) break;
    }

    if (!viewHref) return;

    const url = normalizeUrl(
      viewHref.startsWith("http") ? viewHref : `https://hu.talent.com${viewHref}`
    );

    if (seen.has(url)) return;
    seen.add(url);

    jobs.push({
      title,
      url,
      company,
      experience: inferTalentExperience(title) ?? "-",
    });
  });

  return jobs;
}

async function fetchAllTalentJobs() {
  const allJobs = [];
  const seen = new Set();
  // If any keyword crawl hits a fetch error the URL set is incomplete. Since
  // the reconcile is reactivate-only nowadays this flag is log-only, but it
  // still tells a flaky run apart from a clean one.
  let complete = true;

  for (const searchUrl of TALENT_SEARCH_URLS) {
    const keyword = searchUrl.match(/k=([^&]+)/)?.[1] || "?";
    let pagesVisited = 0;
    let stopReason = "max-pages";
    let totalAddedForKeyword = 0;

    for (let page = 1; page <= TALENT_MAX_PAGES; page += 1) {
      const pageUrl = buildTalentPagedUrl(searchUrl, page);
      let html;
      try {
        html = await fetchText(pageUrl);
      } catch (err) {
        await logFetchError("cron_jobs_T", { url: pageUrl, message: err.message, extra: { source: "talent" } });
        console.log(`talent: failed ${pageUrl}: ${err.message}`);
        stopReason = "fetch-error";
        complete = false;
        break;
      }

      pagesVisited = page;

      const jobs = extractTalentJobs(html);
      if (jobs.length === 0) {
        stopReason = "empty";
        break;
      }

      let newOnPage = 0;
      for (const job of jobs) {
        const canonical = normalizeUrl(job.url);
        if (!seen.has(canonical)) {
          seen.add(canonical);
          allJobs.push(job);
          newOnPage += 1;
        }
      }
      totalAddedForKeyword += newOnPage;

      console.log(`talent[${keyword}] page ${page}: ${jobs.length} jobs, ${newOnPage} new`);

      if (newOnPage === 0) {
        stopReason = "no-new";
        break;
      }

      await sleep(1000);
    }

    console.log(`talent[${keyword}] done — pages=${pagesVisited}, added=${totalAddedForKeyword}, stop=${stopReason}`);
    await sleep(1000);
  }

  return { jobs: allJobs, complete };
}

/* ── handler ────────────────────────────────────────────────── */

const _runJob = withTimeout("cron_jobs_T-background", async (request) => {
  _filters = await loadFilters();
  const client = await pool.connect();

  try {
    await purgeBlockedCompanies(client, "talent");

    /* talent.com */
    const { jobs: rawJobs, complete } = await fetchAllTalentJobs();
    const afterSenior = rawJobs.filter((job) => !isSeniorLike(job.title));
    const talentJobs = afterSenior.filter((job) => !isBlockedCompany(job.company, "talent"));
    console.log(
      `talent: ${talentJobs.length} unique jobs found (after senior+company filter, ` +
      `blocked_company=${afterSenior.length - talentJobs.length}), complete=${complete}`
    );

    // Only a genuinely NEW posting needs its detail page — an already-known url's
    // row is already complete and ON CONFLICT DO NOTHING would discard the fetch
    // anyway. Title inference (inferTalentExperience) already resolved most jobs;
    // only the "-" ones (title didn't reveal seniority) need the fetch. Either
    // way the row is built COMPLETE before it's ever inserted — no separate pass
    // comes back later to patch it in.
    const { rows: knownRows } = await client.query(
      `SELECT url FROM job_posts WHERE source = 'talent' AND url = ANY($1::text[])`,
      [talentJobs.map((j) => j.url)]
    );
    const known = new Set(knownRows.map((r) => r.url));

    for (const job of talentJobs) {
      if (!known.has(job.url) && job.experience === "-") {
        try {
          await sleep(400);
          const html = await fetchText(job.url);
          const normalizedHtml = html.replace(/–/g, "-").replace(/—/g, "-");
          job.experience = extractTalentExperience(normalizedHtml) || "-";
          job.technologies = extractTechnologies(normalizedHtml);
        } catch (err) {
          await logFetchError("cron_jobs_T", { url: job.url, message: err.message, extra: { source: "talent" } });
        }
      }
      await upsertJob(client, "talent", job);
    }
    console.log(`talent: ${talentJobs.length} jobs processed`);

    // complete:false → reactivate-only, NEVER listing-diff deactivation.
    // talent's search results are a rotating nondeterministic SUBSET of the
    // source (2026-07-10 probe: 61 aged live rows absent from a clean full
    // crawl, 5/5 spot-checks live) AND the listing keeps showing closed jobs —
    // so absence proves nothing and presence proves nothing. The listing-diff
    // deactivate/reactivate churn (~30 flips/day) was pure rotation noise.
    // Deactivation is owned entirely by the daily 404-sweep (HTTP 404 +
    // id-anchored system_status=2, _active_core.mjs BANNER_DEAD_SOURCES), and
    // its kills are sticky (sweep_dead + STICKY_SWEEP_DEAD_SOURCES) so this
    // reactivation can't resurrect a closed-but-still-listed job either.
    const rc = await reconcileActive(client, "talent", talentJobs.map((j) => j.url), { complete: false });
    console.log(`[talent] active reconcile (reactivate-only) — ${JSON.stringify(rc)}`);
  } finally {
    client.release();
  }

  return new Response("OK");
});

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  const expected = process.env.CRON_SECRET;
  if (!expected || token !== expected) {
    return new Response("Unauthorized", { status: 401 });
  }
  return _runJob(request);
};
