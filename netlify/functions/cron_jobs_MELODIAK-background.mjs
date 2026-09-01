/*
  MelóDiák – IT kategória scraper

  API: GET https://web-api.melodiak.hu/v1/job-advertisement?page=N
  Returns 50 jobs/page, no server-side category filter — client-side filter needed.
  Filter: city_name === "Budapest" ÉS (category.slug === "informatikai-mernoki-muszaki"
          VAGY a cím egyértelmű IT-jelet ad — lásd STRONG_IT_TITLE, 2026-08-21)
  Job URL: https://www.melodiak.hu/diakmunkak/{slug}

  Flow:
    1. Paginate GET /v1/job-advertisement until empty page
    2. Filter IT + Budapest client-side
    3. Senior filter via _filters
    4. Upsert (source = "melodiak", experience = "diákmunka")
*/

import { Pool } from "pg";
import https from "https";
import { loadFilters } from "./load_filters.mjs";
import { withTimeout } from "./_error-logger.mjs";
import { reconcileActive } from "./_active_core.mjs";
import { shouldSkipTitleFilter, seniorAwareExperience } from "./_seniority_policy.mjs";
import { STRONG_IT_TITLE } from "./_ai_ingest_core.mjs";
import { extractTechnologies, ensureTechnologiesColumn, fetchText } from "./_experience_core.mjs";

let _filters = [];

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

const BASE = "https://www.melodiak.hu";
const API_BASE = "https://web-api.melodiak.hu/v1/job-advertisement";
const IT_SLUG = "informatikai-mernoki-muszaki";

// 2026-08-21 (coverage audit): a forrás maga sorolja be rosszul a hirdetéseit —
// az "Adatelemző_adattudós gyakornok a Szerencsejáték Zrt-nél!" a
// `gazdasagi-penzugyi-marketing` slugon ült, így a slug-szűrő sosem látta.
//
// A slug-szűrőt NEM tágítjuk (a `job_categories` teljes keyword-listáját ráengedve
// 300 élő hirdetésből 6 jött volna be: 1 valódi + 5 fals pozitív — "Office manager
// assistant", "Irodai, admin munka", "Kontroller gyakornok", "Elemzési gyakornok",
// "Robotporszívó-tesztelő" —, vagyis pont a 2026-07-29-i muisz kat.4 hibája).
//
// Helyette: a NEM-IT slugokról csak EGYÉRTELMŰ IT-jelre engedünk be. Szándékosan
// nincs benne a puszta "tesztelő" (robotporszívó-tesztelő!), "elemző", "admin",
// "manager", "kontroller" — ezek a fenti fals pozitívok forrásai.
// Élő mérés a felvételkor: a teljes 300-as listán pontosan 1 sort hoz be, a
// valódi hiányzót, 0 fals pozitívval.
// A mintát a _ai_ingest_core.mjs tartja (a muisz is ugyanezt használja) — egy
// másolat, hogy a két scraper IT-kapuja ne csússzon szét.

/* ── helpers ─────────────────────────────────────────────────── */

function normalizeWhitespace(v) {
  return String(v ?? "").replace(/\s+/g, " ").trim();
}

function normalizeText(v) {
  return String(v ?? "")
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
    ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid"]
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const req = https.request(
      parsedUrl,
      {
        method: "GET",
        headers: {
          "User-Agent": "Mozilla/5.0",
          Accept: "application/json",
        },
        timeout: 25000,
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(data)); }
            catch { reject(new Error(`JSON parse error at ${url}`)); }
          } else {
            reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          }
        });
        res.on("error", reject);
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
    [
      source,
      item.title,
      item.url,
      seniorAwareExperience(item.title, item.experience) ?? "-",
      item.technologies ?? null,
    ]
  );
  return res.rowCount > 0;
}

/* ── handler ─────────────────────────────────────────────────── */

export default withTimeout("cron_jobs_MELODIAK-background", async () => {
  _filters = await loadFilters();
  const client = await pool.connect();

  let newlyInserted = 0;
  let alreadyExisted = 0;
  let skippedSenior = 0;
  let totalFetched = 0;
  let fetchFailed = 0;
  let detailFetchFailed = 0;

  try {
    await ensureTechnologiesColumn(client);

    // A /v1/job-advertisement lista csak cím/város/bér/címkék — hirdetés-törzs
    // nincs benne, ezért maradt a technologies 2026-09-01-ig NULL. A
    // /diakmunkak/{slug} detail-oldal viszont szerver-renderelt (élőben
    // igazolva 2026-09-01), tehát csak a fetch hiányzott. CSAK genuinely-új
    // url-re megy le — a lenti upsert ON CONFLICT DO NOTHING-ja meglévő sort
    // úgysem írna felül.
    const knownUrls = new Set(
      (await client.query(`SELECT url FROM job_posts WHERE source = $1`, ["melodiak"])).rows.map((r) => r.url)
    );

    const foundUrls = [];
    for (let page = 1; page <= 20; page++) {
      let result;
      try {
        await sleep(500);
        result = await fetchJson(`${API_BASE}?page=${page}`);
      } catch (err) {
        fetchFailed++;
        console.error(`[melodiak] page ${page} fetch failed: ${err.message}`);
        break;
      }

      const jobs = result?.data?.resource ?? [];
      if (jobs.length === 0) {
        console.log(`[melodiak] page ${page} empty, done`);
        break;
      }

      totalFetched += jobs.length;

      for (const job of jobs) {
        const catSlug = job.category?.slug ?? "";
        if (normalizeText(job.city_name ?? "") !== "budapest") continue;

        const title = normalizeWhitespace(job.title);
        if (!title) continue;

        // Az IT-slug önmagában elég; azon kívülről csak egyértelmű IT-cím jöhet be.
        if (catSlug !== IT_SLUG && !STRONG_IT_TITLE.test(title)) continue;

        if (shouldSkipTitleFilter(title, _filters)) {
          skippedSenior++;
          console.log(`[melodiak] SKIP senior "${title}"`);
          continue;
        }

        const jobUrl = `${BASE}/diakmunkak/${job.slug}`;

        // A teljes sor a beszúrás ELŐTT áll össze (nincs fetch-then-UPDATE).
        let technologies = null;
        if (!knownUrls.has(jobUrl)) {
          await sleep(500);
          try {
            technologies = extractTechnologies(await fetchText(jobUrl));
          } catch (err) {
            detailFetchFailed++;
            console.error(`[melodiak] technologies fetch failed ${jobUrl}: ${err.message}`);
          }
        }

        const wasNew = await upsertJob(client, "melodiak", {
          title,
          url: jobUrl,
          experience: "diákmunka",
          technologies,
        });
        foundUrls.push(jobUrl);

        if (wasNew) {
          newlyInserted++;
          console.log(`[melodiak] NEW "${title}" tech=[${technologies ?? "-"}] → ${jobUrl}`);
        } else {
          alreadyExisted++;
          console.log(`[melodiak] EXISTS "${title}"`);
        }
      }
    }

    console.log(
      `[melodiak] DONE — fetched=${totalFetched}, new=${newlyInserted}, existed=${alreadyExisted}, ` +
      `skipped_senior=${skippedSenior}, fetch_failed=${fetchFailed}, detail_fetch_failed=${detailFetchFailed}`
    );

    const complete = fetchFailed === 0;
    const rc = await reconcileActive(client, "melodiak", foundUrls, { complete });
    console.log(`[melodiak] active reconcile — complete=${complete}, ${JSON.stringify(rc)}`);
  } finally {
    client.release();
  }
});
