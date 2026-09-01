/*
  UniCredit Bank Hungary scraper
  Platform: Avature SSR — jobs in static HTML on the list URL
  URL pre-filters Budapest (no extra location filtering needed)

  2026-07-29 (coverage audit): the URL used to ALSO pre-filter by a hardcoded
  functional-area taxonomy (`&7620=[8883456,8883450,8883440,12016019]`) —
  UniCredit's Avature backend renumbered/retired those ids at some point, so
  the filtered query silently returned 0 real postings (200 OK, just a
  Talent-Community CTA card) while the DB kept one stale row. The taxonomy
  autocomplete widget (`AutocompleteSelectFieldUIWidget`) populates its
  options via a client-side AJAX call with no ids present in the static
  HTML, so there's no discoverable "correct" id to swap in. Removed the
  category param entirely and replaced it with a code-side title keyword
  gate (isItJob, same one the AI-scraped pipeline uses) so the scraper
  doesn't start ingesting every Budapest banking/sales/compliance role —
  this is also more robust than a hardcoded taxonomy id going forward.

  Flow:
    1. GET list URL (Budapest), paginated via &jobOffset=N — the site caps
       jobRecordsPerPage at 15 regardless of what's requested
    2. Parse <article class="article--result"> blocks → title + URL
    3. Skip if !isItJob(title) — not a dev/engineering/IT role
    4. Skip if isSeniorLike(title) OR title contains "senior"
    5. Intern: isInternshipTitle(title)
    6. Fetch detail page → extractBodyExperience for non-intern jobs
*/

import { Pool } from "pg";
import https from "https";
import http from "http";
import zlib from "zlib";
import { load as cheerioLoad } from "cheerio";
import { loadFilters } from "./load_filters.mjs";
import { loadCategories } from "./load_categories.mjs";
import { isItJob } from "./_ai_ingest_core.mjs";
import { withTimeout } from "./_error-logger.mjs";
import { reconcileActive } from "./_active_core.mjs";
import { extractBodyExperience, extractTechnologies, ensureTechnologiesColumn, isInternshipTitle, isSeniorExperience } from "./_experience_core.mjs";
import { shouldSkipTitleFilter, shouldSkipSeniorExperience, seniorAwareExperience } from "./_seniority_policy.mjs";

let _filters = [];

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

// jobRecordsPerPage is a request hint the site ignores — it always returns 15
// articles/page regardless (confirmed live 2026-07-29) and pages via
// &jobOffset=N. The old category-filtered query never had more than ~2
// results so this was never exercised; the unfiltered Budapest listing has
// ~50, so pagination is now required or 35+ real postings would be silently
// dropped (and reconcileActive would wrongly deactivate previously-seen ones).
const UNICREDIT_PAGE_SIZE = 15;
const LIST_URL_BASE =
  "https://careers.unicredit.eu/hu_HU/jobsuche/SearchJobs/" +
  "?1286=%5B1888%5D&1286_format=1068&" +
  "&12248=%5B12264283%5D&12248_format=8929" +
  `&listFilterMode=1&jobRecordsPerPage=${UNICREDIT_PAGE_SIZE}`;

function unicreditPageUrl(offset) {
  return offset > 0 ? `${LIST_URL_BASE}&jobOffset=${offset}` : LIST_URL_BASE;
}

/* ── helpers ─────────────────────────────────────────────────── */

function normalizeText(v) {
  return String(v ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeWhitespace(v) {
  return String(v ?? "").replace(/\s+/g, " ").trim();
}

function normalizeUrl(raw) {
  try {
    const u = new URL(raw);
    u.hash = "";
    ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid"]
      .forEach((p) => u.searchParams.delete(p));
    return u.toString().replace(/\?$/, "");
  } catch {
    return raw;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function _blacklistRegex(k) {
  const escaped = normalizeText(k).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i");
}

function isSeniorLike(title) {
  return shouldSkipTitleFilter(title, _filters);
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
          Accept: "text/html,*/*;q=0.8",
          "Accept-Language": "hu-HU,hu;q=0.9,en;q=0.8",
          "Accept-Encoding": "gzip,deflate,br",
        },
        timeout: 25000,
      },
      (res) => {
        const code = res.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(code)) {
          const loc = res.headers.location;
          if (!loc) return reject(new Error(`HTTP ${code} (no Location) for ${url}`));
          if (redirectLeft <= 0) return reject(new Error(`Too many redirects for ${url}`));
          res.resume();
          return resolve(fetchText(new URL(loc, url).toString(), redirectLeft - 1));
        }
        const enc = String(res.headers["content-encoding"] || "").toLowerCase();
        let stream = res;
        if (enc.includes("gzip")) stream = res.pipe(zlib.createGunzip());
        else if (enc.includes("deflate")) stream = res.pipe(zlib.createInflate());
        else if (enc.includes("br")) stream = res.pipe(zlib.createBrotliDecompress());
        let body = "";
        stream.setEncoding("utf8");
        stream.on("data", (c) => (body += c));
        stream.on("end", () =>
          code >= 200 && code < 300 ? resolve(body) : reject(new Error(`HTTP ${code} for ${url}`))
        );
        stream.on("error", reject);
      }
    );
    req.on("timeout", () => req.destroy(new Error(`Timeout for ${url}`)));
    req.on("error", reject);
    req.end();
  });
}

/* ── db ──────────────────────────────────────────────────────── */

async function upsertJob(client, source, item) {
  const res = await client.query(
    `INSERT INTO job_posts (source, title, url, experience, technologies, first_seen)
     VALUES ($1,$2,$3,$4,$5,NOW())
     ON CONFLICT (source, url) DO NOTHING
     RETURNING id;`,
    [source, item.title, item.url, seniorAwareExperience(item.title, item.experience) ?? "-", item.technologies ?? null]
  );
  return res.rowCount > 0;
}

/* ── handler ─────────────────────────────────────────────────── */

export default withTimeout("cron_jobs_UNICREDIT-background", async () => {
  _filters = await loadFilters();
  const categories = await loadCategories();
  const client = await pool.connect();
  try {
    await ensureTechnologiesColumn(client);
    const foundUrls = [];

    // Paginate the Budapest listing (see UNICREDIT_PAGE_SIZE comment above).
    // MAX_PAGES is a generous safety cap, not an expected ceiling — current
    // live volume is ~50/15 ≈ 4 pages.
    const MAX_PAGES = 20;
    const jobs = [];
    let listFetchFailed = false;

    for (let page = 0; page < MAX_PAGES; page++) {
      const offset = page * UNICREDIT_PAGE_SIZE;
      const pageUrl = unicreditPageUrl(offset);
      let pageHtml;
      try {
        pageHtml = await fetchText(pageUrl);
      } catch (err) {
        console.error(`[unicredit] list fetch failed (offset ${offset}): ${err.message}`);
        listFetchFailed = true;
        break;
      }

      const $page = cheerioLoad(pageHtml);
      const articles = $page("article.article--result").toArray();
      if (!articles.length) break; // natural end of listing

      for (const el of articles) {
        const $a = $page(el).find("h3.article__header__text__title--6 a").first();
        const title = normalizeWhitespace($a.text());
        const url = normalizeWhitespace($a.attr("href"));
        if (title && url) jobs.push({ title, url });
      }

      console.log(`[unicredit] page offset=${offset}: ${articles.length} articles`);
      if (articles.length < UNICREDIT_PAGE_SIZE) break; // short page = natural end
    }

    if (!jobs.length && listFetchFailed) {
      console.error(`[unicredit] aborting — first page fetch failed and no jobs collected`);
      return;
    }

    console.log(`[unicredit] list: ${jobs.length} jobs found across pagination`);

    // Intern-titled rows skip the detail fetch below (experience is already
    // known from the title) — but technologies still needs it. Fetch that once,
    // for genuinely NEW urls only: the upsert is ON CONFLICT DO NOTHING, so a
    // fetch against an already-known url would just be thrown away.
    const knownUrls = new Set(
      (await client.query(`SELECT url FROM job_posts WHERE source = $1`, ["unicredit"])).rows.map((r) => r.url)
    );

    let newlyInserted = 0;
    let alreadyExisted = 0;
    let skippedSenior = 0;
    let skippedNoTitle = 0;
    let skippedNonIt = 0;
    let detailFetchFailed = 0;

    for (const job of jobs) {
      try {
        if (!job.title) {
          skippedNoTitle++;
          console.log(`[unicredit] SKIP no-title → ${job.url}`);
          continue;
        }
        if (!isItJob(job.title, categories)) {
          skippedNonIt++;
          console.log(`[unicredit] SKIP non-IT "${job.title}" → ${job.url}`);
          continue;
        }
        if (shouldSkipTitleFilter(job.title, _filters)) {
          skippedSenior++;
          console.log(`[unicredit] SKIP senior "${job.title}" → ${job.url}`);
          continue;
        }

        let source = "unicredit";
        let experience;
        let technologies = null;

        if (isInternshipTitle(job.title)) {
          experience = "diákmunka";
          if (!knownUrls.has(job.url)) {
            await sleep(800);
            try {
              const detailHtml = await fetchText(job.url);
              const normalizedHtml = detailHtml.replace(/–/g, "-");
              technologies = extractTechnologies(normalizedHtml);
            } catch (err) {
              detailFetchFailed++;
              console.error(`[unicredit] technologies fetch failed ${job.url}: ${err.message}`);
            }
          }
        } else {
          await sleep(800);
          try {
            const detailHtml = await fetchText(job.url);
            // Body uses em-dash ("1–3 év") which extractBodyExperience may not match
            const normalizedHtml = detailHtml.replace(/–/g, "-");
            experience = extractBodyExperience(normalizedHtml) || "-";
            technologies = extractTechnologies(normalizedHtml);
          } catch (err) {
            // The job's existence is already known from the LIST (title too) —
            // keep it (experience "-") and still upsert + push to foundUrls.
            // The old `continue` dropped it from foundUrls, so active-reconcile
            // could wrongly deactivate a live job on a flaky detail fetch.
            detailFetchFailed++;
            console.error(`[unicredit] detail fetch failed ${job.url}: ${err.message}`);
            experience = "-";
          }
        }

        if (shouldSkipSeniorExperience(isSeniorExperience(experience))) {
          skippedSenior++;
          console.log(`[unicredit] SKIP senior-experience [${experience}] "${job.title}" → ${job.url}`);
          continue;
        }

        const wasNew = await upsertJob(client, source, {
          title: job.title,
          url: job.url,
          experience,
          technologies,
        });
        foundUrls.push(job.url);
        if (wasNew) {
          newlyInserted++;
          console.log(`[unicredit] NEW [${source}] "${job.title}" exp=${experience} → ${job.url}`);
        } else {
          alreadyExisted++;
          console.log(`[unicredit] EXISTS [${source}] "${job.title}" → ${job.url}`);
        }
      } catch (err) {
        console.error(`[unicredit] job processing failed: ${err.message}`);
      }
    }

    console.log(
      `[unicredit] DONE — total=${jobs.length}, new=${newlyInserted}, existed=${alreadyExisted}, ` +
      `skipped_senior=${skippedSenior}, skipped_non_it=${skippedNonIt}, skipped_no_title=${skippedNoTitle}, fetch_failed=${detailFetchFailed}`
    );

    // complete=false when pagination broke mid-way (listFetchFailed) — a
    // partial listing must not be treated as the full current set, or
    // reconcileActive would wrongly deactivate jobs on unseen pages. Detail
    // (per-job) fetch failures don't affect this — they no longer drop jobs
    // from foundUrls (see the catch above).
    const complete = !listFetchFailed;
    const rc = await reconcileActive(client, "unicredit", foundUrls, { complete });
    console.log(`[unicredit] active reconcile — complete=${complete}, ${JSON.stringify(rc)}`);
  } finally {
    client.release();
  }
});
