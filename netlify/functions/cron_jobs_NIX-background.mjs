/*
  NIX (nixstech.com) karrier oldal scraper
  Platform: WordPress — public REST API (no HTML scraping needed).

  API: GET https://nixstech.com/wp-json/wp/v2/vacancy?per_page=100
       Every open vacancy in ONE request, each with:
         - link            → https://nixstech.com/career/<slug>/  (stable, = row url)
         - title.rendered   (HTML-entity encoded)
         - content.rendered → full job description HTML (experience/tech extraction,
                              no extra fetch — the row is fully built before insert)
         - levels[]         → seniority taxonomy term ids

  Seniority taxonomy (GET /wp-json/wp/v2/levels), verified 2026-07-20:
    52 junior · 54 junior-strong · 142 trainee · 55 medior · 53 senior · 150 lead
  We resolve term id → slug at runtime (one extra GET, falls back to the hardcoded
  table if that request fails) so a WordPress term renumber can't silently mis-tag
  everyone.

  Flow (mirrors cron_jobs_MFB — single company, one API call = full listing):
    1. GET the levels taxonomy → id→slug map (fallback: LEVEL_SLUG_FALLBACK).
    2. GET all vacancies (one request).
    3. Drop a vacancy ONLY on the job_filters title denylist (isSeniorLike) — the
       same single, uniform senior gate every scraper uses (user decision
       2026-07-20). A senior/lead levels-taxonomy tag or a high description
       year-range is NOT dropped: the row is SAVED and merely flagged in the UI.
    4. experience label: title override wins (codebase convention), then the level
       band (trainee→diákmunka, junior/strong-junior→junior, medior→medior,
       senior/lead→"senior" so the UI badge catches it), then the description
       year-range as a last resort (kept even when high).
    5. Extract technologies from content.rendered (no extra fetch).
    6. Upsert on (source, url); reconcileActive with the complete listing.

  All NIX vacancies are Budapest / on-site, so no location filter is needed.
  The url is a stable slug (no volatile id) → no migrateVolatileUrl.
*/

import { Pool } from "pg";
import https from "https";
import http from "http";
import zlib from "zlib";
import { load as cheerioLoad } from "cheerio";
import { loadFilters } from "./load_filters.mjs";
import { withTimeout } from "./_error-logger.mjs";
import { reconcileActive } from "./_active_core.mjs";
import {
  isInternshipTitle,
  isJuniorTitle,
  isMidLevelTitle,
  extractBodyExperience,
  extractTechnologies,
  isSeniorExperience,
} from "./_experience_core.mjs";
import { shouldSkipTitleFilter, shouldSkipSeniorExperience, seniorAwareExperience } from "./_seniority_policy.mjs";
import { computeLevel } from "../../src/lib/experienceLevel.mjs";

let _filters = [];

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

const BASE = "https://nixstech.com";
const VACANCY_API = `${BASE}/wp-json/wp/v2/vacancy?per_page=100&_fields=id,link,title,content,levels,date`;
const LEVELS_API = `${BASE}/wp-json/wp/v2/levels?per_page=100&_fields=id,slug`;

// term id → slug fallback (verified 2026-07-20); the runtime map overrides this.
const LEVEL_SLUG_FALLBACK = {
  52: "junior",
  54: "junior-strong",
  142: "trainee",
  55: "medior",
  53: "senior",
  150: "lead",
};

// slug → seniority rank (lower = more junior). A multi-tagged vacancy's effective
// seniority is the MIN rank — a job open to both junior and senior is
// junior-friendly — matching the fail-open philosophy used elsewhere.
const SLUG_RANK = {
  trainee: 0,
  "junior-strong": 1,
  junior: 1,
  medior: 2,
  senior: 3,
  lead: 3,
};
const RANK_EXPERIENCE = { 0: "diákmunka", 1: "junior", 2: "medior" };
const SENIOR_RANK = 3;

/* ── helpers ─────────────────────────────────────────────────── */

function normalizeText(s) {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeWhitespace(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

// WordPress title.rendered ships HTML entities ("&amp;", "&#8211;") — decode to
// plain text for storage and for the title-based seniority helpers.
function htmlToText(html) {
  const $ = cheerioLoad(`<div>${html || ""}</div>`);
  return normalizeWhitespace($("div").text());
}

function normalizeUrl(raw) {
  try {
    const u = new URL(raw);
    u.hash = "";
    ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
     "fbclid", "gclid", "gad_source", "gclsrc", "gbraid"].forEach((p) => u.searchParams.delete(p));
    return u.toString().replace(/\?$/, "");
  } catch {
    return raw;
  }
}

function _blacklistRegex(k) {
  const escaped = normalizeText(k).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i");
}

// job_filters title denylist (senior/lead/architect… words) — same signal every
// other scraper uses.
function isSeniorLike(title) {
  return shouldSkipTitleFilter(title, _filters);
}

// Lowest (most junior) seniority rank across a vacancy's level term ids, or null
// when it carries no recognized level tag.
function effectiveLevelRank(levelIds, slugMap) {
  let min = null;
  for (const id of levelIds || []) {
    const slug = slugMap[id];
    const rank = slug != null ? SLUG_RANK[slug] : undefined;
    if (rank == null) continue;
    if (min == null || rank < min) min = rank;
  }
  return min;
}

// Seniority rank implied by the title alone, or null when the title is neutral.
function titleRank(title) {
  if (isInternshipTitle(title)) return 0;
  if (isJuniorTitle(title)) return 1;
  if (isMidLevelTitle(title)) return 2;
  return null;
}

/* ── fetch (gzip/deflate/br + redirect) ──────────────────────── */

function getText(url, redirectLeft = 5) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;

    const req = lib.request(
      u,
      {
        method: "GET",
        headers: {
          "User-Agent": "JobWatcher/1.0",
          Accept: "application/json, */*;q=0.8",
          "Accept-Language": "en;q=0.9,hu;q=0.8",
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
          return resolve(getText(new URL(loc, url).toString(), redirectLeft - 1));
        }

        const enc = String(res.headers["content-encoding"] || "").toLowerCase();
        let stream = res;
        if (enc.includes("gzip")) stream = res.pipe(zlib.createGunzip());
        else if (enc.includes("deflate")) stream = res.pipe(zlib.createInflate());
        else if (enc.includes("br")) stream = res.pipe(zlib.createBrotliDecompress());

        let data = "";
        stream.setEncoding("utf8");
        stream.on("data", (c) => (data += c));
        stream.on("end", () =>
          code >= 200 && code < 300 ? resolve(data) : reject(new Error(`HTTP ${code} for ${url}`))
        );
        stream.on("error", reject);
      }
    );

    req.on("timeout", () => req.destroy(new Error(`Timeout for ${url}`)));
    req.on("error", reject);
    req.end();
  });
}

async function getJson(url) {
  return JSON.parse(await getText(url));
}

async function loadLevelSlugMap() {
  try {
    const terms = await getJson(LEVELS_API);
    const map = {};
    if (Array.isArray(terms)) {
      for (const t of terms) if (t && t.id != null && t.slug) map[t.id] = t.slug;
    }
    return Object.keys(map).length ? map : { ...LEVEL_SLUG_FALLBACK };
  } catch (err) {
    console.warn(`[nix] levels taxonomy fetch failed (${err.message}) — using hardcoded map`);
    return { ...LEVEL_SLUG_FALLBACK };
  }
}

/* ── db ──────────────────────────────────────────────────────── */

async function upsertJob(client, source, item) {
  const experience = seniorAwareExperience(item.title, item.experience) ?? "-";
  const res = await client.query(
    `INSERT INTO job_posts (source, title, url, experience, company, technologies, level, first_seen)
     VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
     ON CONFLICT (source, url) DO NOTHING
     RETURNING id;`,
    [source, item.title, item.url, experience, "NIX", item.technologies ?? null, computeLevel({ title: item.title, experience, source })]
  );
  return res.rowCount > 0;
}

/* ── handler ─────────────────────────────────────────────────── */

const _runJob = withTimeout("cron_jobs_NIX-background", async () => {
  _filters = await loadFilters();
  const client = await pool.connect();
  try {
    const slugMap = await loadLevelSlugMap();

    let vacancies;
    try {
      vacancies = await getJson(VACANCY_API);
    } catch (err) {
      console.error(`[nix] vacancy api fetch failed: ${err.message}`);
      return new Response("fetch failed", { status: 200 });
    }
    if (!Array.isArray(vacancies)) {
      console.error(`[nix] unexpected API shape (not an array)`);
      return new Response("bad shape", { status: 200 });
    }

    console.log(`[nix] list: ${vacancies.length} vacancies`);

    const foundUrls = [];
    let newlyInserted = 0;
    let alreadyExisted = 0;
    let skippedSenior = 0;
    let skippedNoData = 0;
    // A vacancy whose parse throws never reaches foundUrls; mark the crawl
    // incomplete so reconcileActive skips deactivation (a still-live posting we
    // merely failed to parse must not be deactivated). Mirrors MFB.
    let rowParseFailed = false;

    for (const v of vacancies) {
      try {
        const url = normalizeUrl(v?.link || "");
        const title = htmlToText(v?.title?.rendered);
        if (!url || !title) {
          skippedNoData++;
          console.log(`[nix] SKIP no-data (id=${v?.id ?? "?"})`);
          continue;
        }

        const contentHtml = v?.content?.rendered || "";
        const tRank = titleRank(title);
        const lRank = effectiveLevelRank(v?.levels, slugMap);
        const contentYears = extractBodyExperience(contentHtml);

        // Csak a cím-denylist dob (isSeniorLike) — uniform, mint MINDEN scrapernél
        // (user-döntés 2026-07-20). Sem a taxonómia-senior, sem a leírásból becsült
        // magas évszám NEM dob többé: elmentjük, a frontend csak megjelöli (senior
        // badge). A cím marad az egyetlen megbízható, egységes senior-kapu.
        if (shouldSkipTitleFilter(title, _filters)) {
          skippedSenior++;
          console.log(`[nix] SKIP title-denylist "${title}" → ${url}`);
          continue;
        }

        // experience label: title override wins, then the level band; a senior/lead
        // szint (rank 3) "senior"-t kap (a frontend badge a "senior" szót is jelöli),
        // rank nélkül a leírás évszáma marad (magas is bekerül, jelölve).
        const rank = tRank != null ? tRank : lRank;
        const experience =
          rank === SENIOR_RANK ? "senior"
          : rank != null ? RANK_EXPERIENCE[rank]
          : (contentYears || "-");
        const technologies = extractTechnologies(contentHtml);

        // Ideiglenes felülírás (2026-08-01, user-döntés): a fenti 07-20-as "csak
        // cím-denylist dob" szabály mellett most az experience-alapú senior-flag
        // (taxonómia-senior/lead VAGY magas leírás-évszám) is kizár insert előtt.
        if (shouldSkipSeniorExperience(isSeniorExperience(experience))) {
          skippedSenior++;
          console.log(`[nix] SKIP senior-experience [${experience}] "${title}" → ${url}`);
          continue;
        }

        const wasNew = await upsertJob(client, "nix", { title, url, experience, technologies });
        foundUrls.push(url);
        if (wasNew) {
          newlyInserted++;
          console.log(`[nix] NEW "${title}" exp=${experience} tech=${technologies || "-"} → ${url}`);
        } else {
          alreadyExisted++;
        }
      } catch (err) {
        rowParseFailed = true;
        console.error(`[nix] row parse failed: ${err.message}`);
      }
    }

    console.log(
      `[nix] DONE — total=${vacancies.length}, new=${newlyInserted}, existed=${alreadyExisted}, ` +
      `skipped_senior=${skippedSenior}, skipped_no_data=${skippedNoData}`
    );

    // One API response = the full current listing → a complete crawl, so
    // reconcile may deactivate rows that vanished. A parse failure means
    // foundUrls is missing a live posting, so mark it incomplete instead.
    const rc = await reconcileActive(client, "nix", foundUrls, { complete: !rowParseFailed });
    console.log(`[nix] active reconcile — complete=${!rowParseFailed}, ${JSON.stringify(rc)}`);
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
