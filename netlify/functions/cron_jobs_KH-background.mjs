/*
  K&H Bank karrier oldal scraper
  API: POST https://karrier.kh.hu/jsbq
       sRoute=public_job_esearch&q=<urlencoded "filter&page=N">
  Filter: specialities[]=IT és innováció & cities[]=Budapest

  FIGYELEM a lapozásra (2026-08-21-i mérés): a `page` KÜLÖN form-mezőként küldve
  némán hatástalan — az API mindig az 1. oldalt adja vissza. Csak akkor lapoz, ha
  a `page` a `q` értékén BELÜL van, és 1-ALAPÚ (page=1 = első oldal).

      page=0 / 1 / 2 külön mezőként  → total=25, rows=20, mindig ugyanaz
      page=2 a q-n belül             → total=25, rows=5  (a maradék)

  Flow:
    1. POST API with pagination (rowNum=20 per page, page a q-ban, 1-alapú)
    2. Parse each row.row HTML with cheerio
    3. Intern detection (level "szakmai gyakorlat" OR title keywords)
    4. Direct experience field upsert (no detail fetch, no senior filter)
*/

import { Pool } from "pg";
import https from "https";
import http from "http";
import zlib from "zlib";
import { load as cheerioLoad } from "cheerio";
import { loadFilters } from "./load_filters.mjs";
import { withTimeout } from "./_error-logger.mjs";
import { reconcileActive, migrateVolatileUrl, escapeRegex } from "./_active_core.mjs";
import { extractBodyExperience, extractTechnologies, ensureTechnologiesColumn, isInternshipTitle, isSeniorExperience } from "./_experience_core.mjs";
import { shouldSkipTitleFilter, shouldSkipSeniorExperience, seniorAwareExperience } from "./_seniority_policy.mjs";

let _filters = [];

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

const BASE = "https://karrier.kh.hu";
const API = `${BASE}/jsbq`;
const FILTER_Q = "specialities[]=IT és innováció&cities[]=Budapest&";

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

// /allas/{slug}-{id} — the trailing numeric id ROTATES when the posting is
// refreshed (DB evidence: …mobilbank-14912 → -15167), so the url alone can't be
// the row identity. Pattern matches the same slug under any id.
function volatileUrlPattern(url) {
  const m = url.match(/^(.*)-\d+$/);
  return m ? `^${escapeRegex(m[1])}-\\d+$` : null;
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

function postForm(url, body) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const lib = parsedUrl.protocol === "https:" ? https : http;
    const req = lib.request(
      parsedUrl,
      {
        method: "POST",
        headers: {
          "User-Agent": "JobWatcher/1.0",
          Accept: "application/json, text/javascript, */*",
          "Accept-Language": "hu-HU,hu;q=0.9,en;q=0.8",
          "Accept-Encoding": "gzip,deflate,br",
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
          Referer: `${BASE}/allasok`,
        },
        timeout: 25000,
      },
      (res) => {
        const code = res.statusCode || 0;
        const enc = String(res.headers["content-encoding"] || "").toLowerCase();
        let stream = res;
        if (enc.includes("gzip")) stream = res.pipe(zlib.createGunzip());
        else if (enc.includes("deflate")) stream = res.pipe(zlib.createInflate());
        else if (enc.includes("br")) stream = res.pipe(zlib.createBrotliDecompress());

        let buf = "";
        stream.setEncoding("utf8");
        stream.on("data", (c) => (buf += c));
        stream.on("end", () =>
          code >= 200 && code < 300 ? resolve(buf) : reject(new Error(`HTTP ${code} for ${url}`))
        );
        stream.on("error", reject);
      }
    );
    req.on("timeout", () => req.destroy(new Error(`Timeout for ${url}`)));
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// `page` a q stringen BELÜL megy és 1-alapú — külön form-mezőként az API eldobja
// (lásd a fájl fejlécét). A FILTER_Q már `&`-re végződik.
async function fetchPage(page) {
  const q = `${FILTER_Q}page=${page}`;
  const body = `sRoute=public_job_esearch&q=${encodeURIComponent(q)}`;
  const text = await postForm(API, body);
  return JSON.parse(text);
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

export default withTimeout("cron_jobs_KH-background", async () => {
  _filters = await loadFilters();
  const client = await pool.connect();
  try {
    await ensureTechnologiesColumn(client);
    let crawlError = false;
    const foundUrls = [];
    const allRows = [];
    let page = 1; // 1-alapú: page=1 az első oldal (0 ugyanazt adja, de maradjunk a szerződésnél)
    let total = 0;
    let maxPagesLeft = 25; // safety: ha a `total` hazudik, ne pörögjön végtelenül

    do {
      let res;
      try {
        res = await fetchPage(page);
      } catch (err) {
        console.error(`[kh] page ${page} fetch failed: ${err.message}`);
        crawlError = true;
        break;
      }
      total = res.total || 0;
      const rows = Array.isArray(res.rows) ? res.rows : [];
      console.log(`[kh] page ${page}: ${rows.length} jobs (total=${total})`);
      allRows.push(...rows);
      if (rows.length === 0) break;
      page++;
      if (--maxPagesLeft <= 0) {
        // Csonka listát nem szabad teljesnek hazudni: a reconcile különben
        // deaktiválná a le nem kért oldalak élő sorait.
        console.warn(`[kh] oldal-cap kimerült (allRows=${allRows.length}, total=${total}) → complete=false`);
        crawlError = true;
        break;
      }
    } while (allRows.length < total);

    // Dedup by URL
    const seen = new Set();
    const dedup = [];
    for (const r of allRows) {
      if (!r.url || seen.has(r.url)) continue;
      seen.add(r.url);
      dedup.push(r);
    }
    console.log(`[kh] total unique rows: ${dedup.length}`);

    // Full current listing (pre-filter) — a url in this set is live on the
    // source, so migrateVolatileUrl must never rename its row away.
    const currentUrls = dedup.map((r) => `${BASE}${r.url}`);

    // Intern-titled rows skip the detail fetch below (experience is already
    // known from the title) — but technologies still needs it. Fetch that once,
    // for genuinely NEW urls only: the upsert is ON CONFLICT DO NOTHING, so a
    // fetch against an already-known url would just be thrown away.
    const knownUrls = new Set(
      (await client.query(`SELECT url FROM job_posts WHERE source = $1`, ["kh"])).rows.map((r) => r.url)
    );

    let newlyInserted = 0;
    let migratedUrls = 0;
    let alreadyExisted = 0;
    let skippedSenior = 0;
    let skippedNoTitle = 0;
    let detailFetchFailed = 0;

    for (const row of dedup) {
      try {
        const $ = cheerioLoad(row.row || "");
        const title = normalizeWhitespace($('[data-cy="job_title"]').first().text());
        const expRaw = normalizeWhitespace($('[data-cy="experiences"]').first().text());
        const url = `${BASE}${row.url}`;

        if (!title) {
          skippedNoTitle++;
          console.log(`[kh] SKIP no-title → ${url}`);
          continue;
        }

        if (shouldSkipTitleFilter(title, _filters)) {
          skippedSenior++;
          console.log(`[kh] SKIP senior "${title}" → ${url}`);
          continue;
        }

        const expLower = expRaw.toLowerCase();
        let source = "kh";
        let experience;
        let technologies = null;

        if (expLower === "szakmai gyakorlat" || isInternshipTitle(title)) {
          experience = "diákmunka";
          if (!knownUrls.has(url)) {
            await sleep(800);
            try {
              const detailHtml = await fetchText(url);
              technologies = extractTechnologies(detailHtml);
            } catch (err) {
              detailFetchFailed++;
              console.error(`[kh] technologies fetch failed ${url}: ${err.message}`);
            }
          }
        } else {
          await sleep(800);
          try {
            const detailHtml = await fetchText(url);
            experience = extractBodyExperience(detailHtml) || "-";
            technologies = extractTechnologies(detailHtml);
          } catch (err) {
            // The detail fetch only enriches experience; the job's existence is already
            // known from the list. Keep it (experience "-") and still push to foundUrls —
            // dropping it would let active-reconcile wrongly deactivate a live job, and
            // gating `complete` on detail failures (below) disabled deactivation entirely
            // on flaky bank sites.
            detailFetchFailed++;
            console.error(`[kh] detail fetch failed ${url}: ${err.message}`);
            experience = "-";
          }
        }

        if (shouldSkipSeniorExperience(isSeniorExperience(experience))) {
          skippedSenior++;
          console.log(`[kh] SKIP senior-experience [${experience}] "${title}" → ${url}`);
          continue;
        }

        const pattern = volatileUrlPattern(url);
        const migrated = pattern
          ? await migrateVolatileUrl(client, source, url, pattern, currentUrls)
          : false;
        const wasNew = await upsertJob(client, source, { title, url, experience, technologies });
        foundUrls.push(url);
        if (migrated) {
          migratedUrls++;
          console.log(`[kh] MIGRATED [${source}] "${title}" → ${url}`);
        } else if (wasNew) {
          newlyInserted++;
          console.log(`[kh] NEW [${source}] "${title}" exp=${experience} → ${url}`);
        } else {
          alreadyExisted++;
          console.log(`[kh] EXISTS [${source}] "${title}" → ${url}`);
        }
      } catch (err) {
        console.error(`[kh] row parse failed: ${err.message}`);
      }
    }

    console.log(
      `[kh] DONE — total=${dedup.length}, new=${newlyInserted}, migrated=${migratedUrls}, existed=${alreadyExisted}, ` +
      `skipped_senior=${skippedSenior}, skipped_no_title=${skippedNoTitle}, fetch_failed=${detailFetchFailed}`
    );

    // Detail-fetch failures don't threaten completeness: every listed job is in
    // foundUrls regardless, so only a failed LIST crawl should block deactivation.
    const complete = !crawlError;
    const rc = await reconcileActive(client, "kh", foundUrls, { complete });
    console.log(`[kh] active reconcile — complete=${complete}, ${JSON.stringify(rc)}`);

  } finally {
    client.release();
  }
});
