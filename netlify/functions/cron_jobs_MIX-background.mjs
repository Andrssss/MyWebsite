/* =========================
  "https://api.dreamjobs.hu/api/v1/jobs?region=hu&page=1&tags%5Bjob-category%5D%5B%5D=57&tags%5Bjob-category%5D%5B%5D=44&tags%5Bjob-category%5D%5B%5D=49&tags%5Bjob-category%5D%5B%5D=55&tags%5Bjob-category%5D%5B%5D=58&tags%5Boffice-location%5D%5B%5D=2925&scope%5B%5D=isNotBlue&per_page=50",
  "https://melonjobs.hu/wp-json/wp/v2/job-listings?job-categories=63&per_page=100&page=1";
  "https://jobs.kuka.com/tile-search-results/?q=&locationsearch=HU&optionsFacetsDD_department=IT";
*/


import { Pool } from "pg";
import https from "https";
import http from "http";
import zlib from "zlib";
import { load as cheerioLoad } from "cheerio";
import { loadFilters } from "./load_filters.mjs";
import { logFetchError, withTimeout } from "./_error-logger.mjs";
import { reconcileActive, migrateVolatileUrl, escapeRegex } from "./_active_core.mjs";
import {
  extractBodyExperience,
  extractKukaExperience,
  extractTechnologies,
  INTERNSHIP_KEYWORDS,
} from "./_experience_core.mjs";

let _filters = [];

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

const MAX_PAGES = 20;

// 2026-07-01: the API moved the locale into the path — `/api/v1/jobs` now 404s,
// the live endpoint is `/api/v1/{locale}/jobs`. Same query filters still work.
// (The job shape also renamed `slugs` → `slug` as a {en,hu,ro} map, but
// buildDreamJobsUrl already falls back to `job.slug`, so no change needed there.)
const DREAMJOBS_API_URLS = [
  "https://api.dreamjobs.hu/api/v1/hu/jobs?region=hu&page=1&tags%5Bjob-category%5D%5B%5D=57&tags%5Bjob-category%5D%5B%5D=44&tags%5Bjob-category%5D%5B%5D=49&tags%5Bjob-category%5D%5B%5D=55&tags%5Bjob-category%5D%5B%5D=58&tags%5Boffice-location%5D%5B%5D=2925&scope%5B%5D=isNotBlue&per_page=50",
  "https://api.dreamjobs.hu/api/v1/hu/jobs?region=hu&page=1&tags%5Bjob-category%5D%5B%5D=44&tags%5Bjob-category%5D%5B%5D=49&tags%5Bjob-category%5D%5B%5D=57&tags%5Bjob-category%5D%5B%5D=22381&tags%5Boffice-location%5D%5B%5D=2925&tags%5Boffice-location%5D%5B%5D=15990&scope%5B%5D=isNotBlue&per_page=50",
];

// job-categories: 62=Rendszergazda, 110=Tesztelő, 112=IT tanácsadó.
// A korábbi `63` ÜRES kategória volt (élőben ellenőrizve 2026-07-14: 0 találat),
// a 62 és a 112 viszont valódi IT-állásokat tartalmaz, amiket sosem kértünk le
// (Gazdasági informatikus, ERP System Analyst) — lásd SCRAPER_BUG_INVESTIGATION.md.
const MELONJOBS_API_URL =
  "https://melonjobs.hu/wp-json/wp/v2/job-listings?job-categories=62,110,112&per_page=100&page=1";

const KUKA_API_URL =
  "https://jobs.kuka.com/tile-search-results/?q=&locationsearch=HU";


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
          "User-Agent": "JobWatcher/1.0",
          Accept: "application/json,text/plain;q=0.9,*/*;q=0.8",
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

async function fetchJson(url) {
  const text = await fetchText(url);
  return JSON.parse(text);
}

function htmlToText(html) {
  const $ = cheerioLoad(`<div>${html ?? ""}</div>`);
  return normalizeWhitespace($.text());
}

async function upsertJob(client, sourceKey, item) {
  // company backfill: a régebben mentett (company nélküli) sorok is kapjanak
  // cégnevet, amikor újra látjuk őket — meglévő értéket sosem írunk felül
  // (kuka itemeknek nincs company-ja → ott a guard miatt no-op)
  await client.query(
    `INSERT INTO job_posts
      (source, title, url, experience, company, technologies, first_seen)
     VALUES ($1,$2,$3,$4,$5,$6,NOW())
     ON CONFLICT (source, url)
        DO UPDATE SET company = EXCLUDED.company
        WHERE job_posts.company IS NULL AND EXCLUDED.company IS NOT NULL;`,
    [sourceKey, item.title, item.url, item.experience ?? "-", item.company || null, item.technologies ?? null]
  );
}

// Only a genuinely NEW url needs its own detail-page fetch for experience —
// an already-known row is already complete, so the upsert would at most
// backfill its company (never experience/technologies). Builds the row
// COMPLETE before it's ever inserted; no separate pass comes back later to
// patch it in.
async function enrichIfNew(job, known, extract, jobName) {
  if (known.has(job.url) || (job.experience && job.experience !== "-")) return;
  try {
    await sleep(400);
    const html = await fetchText(job.url);
    job.experience = extract(html) || "-";
    job.technologies = extractTechnologies(html);
  } catch (err) {
    await logFetchError(jobName, { url: job.url, message: err.message });
  }
}

/* ── DreamJobs ──────────────────────────────────────────────── */

// DreamJobs slugs come in several shapes: a plain string, a per-language map
// like { en, hu, ro }, or (buggy API) a JSON-blob string of that map. Resolve to
// one clean slug and NEVER let anything JSON-ish / whitespace into a URL.
function resolveDreamSlug(raw, lang) {
  if (raw == null) return "";
  if (typeof raw === "object") {
    return normalizeWhitespace(raw[lang] ?? raw.hu ?? raw.en ?? "");
  }
  let s = normalizeWhitespace(raw);
  if (s.startsWith("{") && s.includes('"')) {
    try {
      const obj = JSON.parse(s);
      s = normalizeWhitespace(obj?.[lang] ?? obj?.hu ?? obj?.en ?? "");
    } catch {
      return "";
    }
  }
  // A real slug never contains JSON / URL-breaking characters.
  return /[{}"\s]/.test(s) ? "" : s;
}

function buildDreamJobsUrl(job) {
  // MINDIG a magyar locale-t tároljuk. Korábban a `job.primary_lang` döntött, így egy
  // angol nyelvű hirdetés /en/-re és az ANGOL slugra került (…/en/…/devops-engineer-58),
  // miközben a lista /hu/-t ad (…/hu/…/devops-engineer-56) → ugyanaz az állás két külön
  // sorként is bekerülhetett (DB: 2 db /en/, 6 db /hu/). A site minden hirdetést kiszolgál
  // /hu/-n. Lásd SCRAPER_BUG_INVESTIGATION.md.
  const lang = "hu";
  const companySlug = resolveDreamSlug(job?.company?.slug, lang);
  const localizedSlug =
    resolveDreamSlug(job?.slugs?.[`slug_${lang}`], lang) ||
    resolveDreamSlug(job?.slugs?.slug_hu, lang) ||
    resolveDreamSlug(job?.slugs?.[lang], lang) ||
    resolveDreamSlug(job?.slugs?.hu, lang) ||
    resolveDreamSlug(job?.slugs, lang) ||
    resolveDreamSlug(job?.slug, lang);

  if (!companySlug || !localizedSlug) return null;

  return normalizeUrl(`https://dreamjobs.hu/${lang}/job/${companySlug}/${localizedSlug}`);
}

// /{lang}/job/{company}/{slug}-{n} — the trailing counter BUMPS when the
// company reposts the ad (DB evidence: artofinfo m365-engineer-1 → -2), so the
// url alone can't be the row identity. Company is part of the prefix, so only
// the same company's same slug matches.
//
// The LOCALE segment is deliberately left open (`[a-z]{2}`) instead of being
// escaped into the prefix: buildDreamJobsUrl now always emits /hu/, so the rows
// still stored under /en/ (2 at the time of the fix) have to be able to migrate
// onto their /hu/ url rather than being inserted a second time.
function dreamjobsVolatileUrlPattern(url) {
  const m = url.match(/^https:\/\/dreamjobs\.hu\/[a-z]{2}\/job\/([^/]+)\/(.+)-\d+$/);
  if (!m) return null;
  const [, company, slugBase] = m;
  return `^https://dreamjobs\\.hu/[a-z]{2}/job/${escapeRegex(company)}/${escapeRegex(slugBase)}-\\d+$`;
}

function pickJobTitle(job) {
  const lang = /^[a-z]{2}$/i.test(String(job?.primary_lang || "")) ? String(job.primary_lang).toLowerCase() : "hu";
  return normalizeWhitespace(job?.name?.[lang]) || normalizeWhitespace(job?.name?.hu) || normalizeWhitespace(job?.name?.en) || null;
}

function extractDreamJobs(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : [];

  return rows
    .map((job) => ({
      title: pickJobTitle(job),
      url: buildDreamJobsUrl(job),
      experience: normalizeWhitespace(job?.tags?.job_level?.slug) || null,
      company: (normalizeWhitespace(job?.company?.name) || null)?.slice(0, 200) ?? null,
    }))
    .filter((item) => item.title && item.url);
}

// Returns { jobs, complete }. `complete` is false when a paging loop ran all the
// way to MAX_PAGES without a natural end — the listing is then TRUNCATED, and
// reconcileActive must not deactivate the rows that fell off the tail. (Same bug
// class that killed 15 live wherewework rows on 2026-07-11: an exhausted page cap
// with no guard reads as "these jobs are gone".)
async function fetchAllDreamJobs() {
  const jobs = [];
  const seen = new Set();
  let complete = true;

  for (const apiUrl of DREAMJOBS_API_URLS) {
    const baseUrl = new URL(apiUrl);
    const perPage = Number.parseInt(baseUrl.searchParams.get("per_page") || "50", 10) || 50;
    let naturalEnd = false;

    for (let page = 1; page <= MAX_PAGES; page += 1) {
      baseUrl.searchParams.set("page", String(page));
      const payload = await fetchJson(baseUrl.toString());
      const pageJobs = extractDreamJobs(payload);

      if (pageJobs.length === 0) { naturalEnd = true; break; }

      for (const job of pageJobs) {
        const key = normalizeUrl(job.url);
        if (!seen.has(key)) {
          seen.add(key);
          jobs.push(job);
        }
      }

      if (pageJobs.length < perPage) { naturalEnd = true; break; }
    }

    if (!naturalEnd) {
      complete = false;
      console.warn(`[dreamjobs] page cap (${MAX_PAGES}) exhausted for ${apiUrl} — listing truncated, skipping deactivation`);
    }
  }

  return { jobs, complete };
}

/* ── MelonJobs ──────────────────────────────────────────────── */


function isBudapestLocation(location) {
  const normalized = normalizeText(location);
  return normalized.includes("budapest") || /\b1\d{3}\b/.test(normalized);
}

// INTERNSHIP_KEYWORDS imported from _experience_core.mjs


function inferExperience(title, description) {
  const titleNorm = normalizeText(title ?? "");
  const fullNorm = normalizeText(`${title ?? ""} ${description ?? ""}`);

  if (INTERNSHIP_KEYWORDS.some(k => fullNorm.includes(k))) return "diákmunka";
  if (_filters.some((kw) => _blacklistRegex(kw).test(titleNorm))) return "senior";
  if (/\bmedior\b/.test(titleNorm)) return "medior";
  if (/\bjunior\b|\bpalyakezdo\b|\bentry level\b/.test(titleNorm)) return "junior";

  return null;
}

function _blacklistRegex(k) {
  const escaped = normalizeText(k).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i");
}

function isSeniorLike(title, description) {
  const normalized = normalizeText(title ?? "");
  return _filters.some((kw) => _blacklistRegex(kw).test(normalized));
}

function extractMelonJobs(payload) {
  const rows = Array.isArray(payload) ? payload : [];

  return rows
    .map((job) => {
      const title = htmlToText(job?.title?.rendered);
      const description = htmlToText(job?.content?.rendered);
      const url = normalizeUrl(job?.link || "");
      const location = normalizeWhitespace(job?.meta?._job_location);
      const company = (normalizeWhitespace(job?.meta?._company_name) || null)?.slice(0, 200) ?? null;

      return {
        title,
        description,
        url,
        location,
        company,
        experience: inferExperience(title, description),
      };
    })
    .filter((job) => job.title && job.url)
    .filter((job) => isBudapestLocation(job.location))
    .filter((job) => !isSeniorLike(job.title, job.description));
}

async function fetchAllMelonJobs() {
  const jobs = [];
  const baseUrl = new URL(MELONJOBS_API_URL);
  const perPage = Number.parseInt(baseUrl.searchParams.get("per_page") || "100", 10) || 100;
  let naturalEnd = false;

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    baseUrl.searchParams.set("page", String(page));
    const payload = await fetchJson(baseUrl.toString());
    const pageJobs = extractMelonJobs(payload);

    if (pageJobs.length === 0 && (!Array.isArray(payload) || payload.length === 0)) { naturalEnd = true; break; }

    jobs.push(...pageJobs);

    if (!Array.isArray(payload) || payload.length < perPage) { naturalEnd = true; break; }
  }

  if (!naturalEnd) console.warn(`[melonjobs] page cap (${MAX_PAGES}) exhausted — listing truncated, skipping deactivation`);
  return { jobs, complete: naturalEnd };
}

/* ── KUKA ───────────────────────────────────────────────────── */

function inferKukaExperience(title) {
  const normalized = normalizeText(title);
  if (_filters.some((kw) => normalized.includes(normalizeText(kw))))
    return "senior";
  if (/\bmedior\b|\bmid\b/.test(normalized)) return "medior";
  // kuka "junior" hirdetései gyakornoki-egyenértékűek (üzleti szabály, korábban
  // egy külön futás utáni SQL-lel javítottuk "junior" → "diákmunka"-ra; most
  // rögtön insert előtt a helyes érték kerül be, nincs utólagos patch).
  if (/\bjunior\b|\bpalyakezdo\b|\bentry.?level\b|\btrainee\b|\bintern\b|\bgyakornok\b/.test(normalized))
    return "diákmunka";
  return null;
}

function extractKukaJobs(html) {
  const $ = cheerioLoad(html);
  const jobs = [];
  const seen = new Set();

  $("li[data-url]").each((_i, el) => {
    const $el = $(el);
    const path = $el.attr("data-url");
    if (!path) return;

    const url = normalizeUrl(`https://jobs.kuka.com${path.replace(/&amp;/g, "&")}`);
    if (seen.has(url)) return;
    seen.add(url);

    const title = normalizeWhitespace(
      $el.find(".jobTitle-link").first().text() ||
        $el.find(".title a").first().text() ||
        $el.find("a[href]").first().text()
    );
    if (!title) return;

    jobs.push({
      title,
      url,
      experience: inferKukaExperience(title),
    });
  });

  return jobs;
}

// SAP tile-search caps at 25 tiles per response and pages via ?startrow=N.
// A single call only returns the first 25, so we page until a short/empty page.
// Getting the FULL listing is what makes reconcileActive safe for kuka.
const KUKA_PAGE_SIZE = 25;
const KUKA_MAX_PAGES = 20;

async function fetchAllKukaJobs() {
  const jobs = [];
  const seen = new Set();
  let naturalEnd = false;
  for (let page = 0; page < KUKA_MAX_PAGES; page += 1) {
    const startrow = page * KUKA_PAGE_SIZE;
    const url = startrow === 0 ? KUKA_API_URL : `${KUKA_API_URL}&startrow=${startrow}`;
    const pageJobs = extractKukaJobs(await fetchText(url));
    let added = 0;
    for (const job of pageJobs) {
      if (seen.has(job.url)) continue;
      seen.add(job.url);
      jobs.push(job);
      added += 1;
    }
    if (pageJobs.length < KUKA_PAGE_SIZE || added === 0) { naturalEnd = true; break; }
  }
  if (!naturalEnd) console.warn(`[kuka] page cap (${KUKA_MAX_PAGES}) exhausted — listing truncated, skipping deactivation`);
  return { jobs, complete: naturalEnd };
}
/* ── handler ────────────────────────────────────────────────── */

const _runJob = withTimeout("cron_jobs_MIX-background", async (request) => {
  _filters = await loadFilters();
  const client = await pool.connect();

  try {
    const { rows: knownRows } = await client.query(
      `SELECT source, url FROM job_posts WHERE source IN ('dreamjobs','melonjobs','kuka')`
    );
    const known = new Map([["dreamjobs", new Set()], ["melonjobs", new Set()], ["kuka", new Set()]]);
    for (const r of knownRows) known.get(r.source)?.add(r.url);

    /* DreamJobs */
    try {
      const { jobs: allDreamJobs, complete: dreamComplete } = await fetchAllDreamJobs();
      // Full current listing (pre-filter) — a url in this set is live on the
      // source, so migrateVolatileUrl must never rename its row away.
      const currentUrls = allDreamJobs.map((j) => j.url);
      const dreamJobs = allDreamJobs.filter((job) => {
        if (isSeniorLike(job.title, "")) return false;
        const exp = String(job.experience || "").toLowerCase();
        if (/\bsenior\b/.test(exp)) return false;
        return true;
      });
      console.log(`dreamjobs: ${dreamJobs.length} jobs found`);

      for (const job of dreamJobs) {
        const pattern = dreamjobsVolatileUrlPattern(job.url);
        if (pattern) {
          const migrated = await migrateVolatileUrl(client, "dreamjobs", job.url, pattern, currentUrls);
          if (migrated) console.log(`[dreamjobs] MIGRATED url → ${job.url}`);
        }
        await enrichIfNew(job, known.get("dreamjobs"), extractBodyExperience, "cron_jobs_MIX");
        await upsertJob(client, "dreamjobs", job);
      }
      console.log(`dreamjobs: ${dreamJobs.length} jobs processed`);
      const rc = await reconcileActive(client, "dreamjobs", dreamJobs.map((j) => j.url), { complete: dreamComplete });
      console.log(`[dreamjobs] active reconcile — ${JSON.stringify(rc)}`);
    } catch (err) {
      await logFetchError("cron_jobs_MIX", { url: "dreamjobs", message: err.message });
      console.error("dreamjobs fetch failed:", err.message);
    }

    /* MelonJobs */
    try {
      const { jobs: melonJobs, complete: melonComplete } = await fetchAllMelonJobs();
      console.log(`melonjobs: ${melonJobs.length} jobs found`);

      for (const job of melonJobs) {
        await enrichIfNew(job, known.get("melonjobs"), extractBodyExperience, "cron_jobs_MIX");
        await upsertJob(client, "melonjobs", job);
      }
      console.log(`melonjobs: ${melonJobs.length} jobs processed`);
      const rc = await reconcileActive(client, "melonjobs", melonJobs.map((j) => j.url), { complete: melonComplete });
      console.log(`[melonjobs] active reconcile — ${JSON.stringify(rc)}`);
    } catch (err) {
      await logFetchError("cron_jobs_MIX", { url: "melonjobs", message: err.message });
      console.error("melonjobs fetch failed:", err.message);
    }

    /* KUKA */
    try {
      // Full paginated listing — the bucket for reconcile. Any fetch error throws
      // out to the catch below, so a partial crawl never reaches reconcileActive.
      const { jobs: allKukaJobs, complete: kukaComplete } = await fetchAllKukaJobs();
      const kukaJobs = allKukaJobs.filter((job) => !isSeniorLike(job.title, ""));
      console.log(`kuka: ${kukaJobs.length} jobs found (of ${allKukaJobs.length} listed)`);

      for (const job of kukaJobs) {
        await enrichIfNew(job, known.get("kuka"), extractKukaExperience, "cron_jobs_MIX");
        await upsertJob(client, "kuka", job);
      }
      console.log(`kuka: ${kukaJobs.length} jobs processed`);
      // Reconcile against the FULL listing (incl. senior) so a still-listed job is
      // never wrongly deactivated just because it now matches the senior filter.
      const rc = await reconcileActive(client, "kuka", allKukaJobs.map((j) => j.url), { complete: kukaComplete });
      console.log(`[kuka] active reconcile — ${JSON.stringify(rc)}`);
    } catch (err) {
      await logFetchError("cron_jobs_MIX", { url: "kuka", message: err.message });
      console.error("kuka fetch failed:", err.message);
    }
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
