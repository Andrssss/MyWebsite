/*
  Valore Basis – IT fejvadász scraper

  Entry point: https://valorebasis.hu/allasok/
  Az oldal flip-kártyákat tartalmaz, minden kártya hátoldalán
  "kattints a részletekért !" link mutat a kategória oldalra.

  Flow:
    1. Hardkódolt kategória URL-ek fetch
    2. h5 elemekből title + státusz parse
       - cím h5: NEM tartalmaz "Jelentkezési határidő"-t
       - státusz h5: tartalmaz "Jelentkezési határidő"-t
    4. Státusz "szünetel" → skip
    5. Munkavégzés helye → Budapest check
    6. extractBodyExperience az inline szövegből
    7. Senior filter via _filters
    8. Upsert (source = "valorebasis", url = kategória URL + "#" + slugify(title))
*/

import { Pool } from "pg";
import https from "https";
import http from "http";
import zlib from "zlib";
import { load as cheerioLoad } from "cheerio";
import { loadFilters } from "./load_filters.mjs";
import { withTimeout } from "./_error-logger.mjs";
import { extractBodyExperience, extractTechnologies, ensureTechnologiesColumn, isInternshipTitle, isSeniorExperience } from "./_experience_core.mjs";
import { reconcileActive } from "./_active_core.mjs";
import { shouldSkipTitleFilter, shouldSkipSeniorExperience, seniorAwareExperience } from "./_seniority_policy.mjs";

let _filters = [];

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

const CATEGORY_URLS = [
  "https://valorebasis.hu/php-fejlesztoi-allasok",
  "https://valorebasis.hu/java-fejlesztoi-allasok/",
  "https://valorebasis.hu/c-fejlesztoi-allasok",
  "https://valorebasis.hu/c-fejlesztoi-allasok-2",
  "https://valorebasis.hu/net-fejlesztoi-allasok/",
  "https://valorebasis.hu/ios-android-fejlesztoi-allasok",
  "https://valorebasis.hu/egyeb-fejlesztoi-poziciok",
  "https://valorebasis.hu/szoftverteszteloi-allasok",
  "https://valorebasis.hu/it-sales-poziciok",
  "https://valorebasis.hu/projektvezetoi-poziciok",
  "https://valorebasis.hu/rendszergazda-mernok-poziciok",
];

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

function slugify(s) {
  return normalizeText(s)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
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

// Deterministic 5-digit number from title — stable across runs, unique per title
function titleHash(s) {
  let h = 0;
  for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) & 0x7fffffff;
  return String(10000 + (h % 90000));
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
          Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
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
          code >= 200 && code < 300
            ? resolve(body)
            : reject(new Error(`HTTP ${code} for ${url}`))
        );
        stream.on("error", reject);
      }
    );

    req.on("timeout", () => req.destroy(new Error(`Timeout for ${url}`)));
    req.on("error", reject);
    req.end();
  });
}

/* ── category page parser ────────────────────────────────────── */

function extractJobs(html, categoryUrl) {
  const $ = cheerioLoad(html);
  const jobs = [];
  const seen = new Set();

  // Struktúra: cím + státusz ("Jelentkezési határidő: ...") egymást követő
  // heading elemek. MELYIK tag-et használja (h4 vagy h5) kategória-oldalanként
  // ÉS akár címen/státuszon belül külön-külön is változik — élőben ellenőrizve
  // 2026-08-18: csak php-fejlesztoi-allasok és net-fejlesztoi-allasok használ
  // h5-öt mindkettőhöz, a másik 9 kategória h4-et használ a címhez (státusz
  // lehet h4 VAGY h5). A régi "csak h5" szelekció ezért 9/11 kategórián NULLA
  // állást adott vissza — ez okozta, hogy egy ténylegesen nyitott C# állás
  // (2026-11-15 határidővel, c-fejlesztoi-allasok) sosem került újra beolvasásra
  // és kiöregedve inaktívvá vált (activation audit finding). Mindkét tag-et
  // szelektáljuk, dokumentum-sorrendben, tag helyett TARTALOM alapján párosítva.
  const headEls = $("h4, h5").toArray();

  for (let i = 0; i < headEls.length; i++) {
    const el = headEls[i];
    const titleText = normalizeWhitespace($(el).text());
    if (!titleText) continue;

    // Státusz elemeket kihagyjuk — csak a cím elemeket dolgozzuk fel
    if (titleText.toLowerCase().includes("jelentkezési határidő")) continue;

    // Duplikált cím kiszűrése (az oldal flip-kártya miatt többszöröz)
    if (seen.has(titleText)) continue;

    // A rákövetkező elem — tartalmaznia kell a státuszt
    const statusEl = headEls[i + 1];
    if (!statusEl) continue;
    const statusText = normalizeWhitespace($(statusEl).text());
    if (!statusText.toLowerCase().includes("jelentkezési határidő")) continue;

    // "Jelentkezési határidő: A keresés szünetel" (search paused) replaces the
    // deadline date when a listing is closed but the card stays on the page —
    // confirmed live 2026-08-18 (php-fejlesztoi-allasok category, "PHP
    // FEJLESZTŐ" card). The header comment above always documented this as
    // step 4 but the check itself was never implemented, so a paused card kept
    // getting upserted/reconciled as active forever (activation audit finding,
    // same date).
    if (normalizeText(statusText).includes("szunetel")) {
      console.log(`[valorebasis] SKIP szünetel "${titleText}"`);
      continue;
    }

    // Szövegtörzs: a cím elemtől a következő cím elemig (nem státusz elem)
    let nextTitleEl = null;
    for (let j = i + 1; j < headEls.length; j++) {
      const t = normalizeWhitespace($(headEls[j]).text()).toLowerCase();
      if (!t.includes("jelentkezési határidő")) { nextTitleEl = headEls[j]; break; }
    }

    const nextSection = nextTitleEl
      ? $(el).nextUntil($(nextTitleEl)).text()
      : $(el).nextAll().text();

    // Budapest validáció
    const locMatch = nextSection.match(/Munkavégzés helye[:\s]*([^\n•◦]+)/i);
    if (locMatch) {
      const loc = normalizeText(locMatch[1]);
      if (!loc.includes("budapest")) {
        console.log(`[valorebasis] SKIP non-Budapest "${titleText}" loc="${locMatch[1].trim()}"`);
        continue;
      }
    }
    // Ha nincs Munkavégzés helye mező → elfogadjuk (site eleve Budapest-fókuszú)

    // Strip company-age phrases ("8 éves múlttal rendelkező" etc.) before extracting
    const cleanSection = nextSection.replace(/\d+\s?(?:\+\s?)?(év|éves|éve)\s+múlt\w*/gi, "");
    // Prefer "Elvárások" section to avoid company intro years
    const elvarasMatch = cleanSection.match(/elv[aá]r[aá]sok[^:]*:([\s\S]{0,1500})/i);
    const experienceSource = elvarasMatch ? elvarasMatch[1] : cleanSection;
    const experience = isInternshipTitle(titleText)
      ? "diákmunka"
      : extractBodyExperience(experienceSource) || "-";
    const technologies = extractTechnologies(experienceSource);

    const baseUrl = categoryUrl.replace(/\/$/, "");
    const syntheticUrl = `${baseUrl}?${titleHash(titleText)}`;

    seen.add(titleText);
    jobs.push({ title: titleText, url: syntheticUrl, experience, technologies });
  }

  return jobs;
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

export default withTimeout("cron_jobs_VALOREBASIS-background", async () => {
  _filters = await loadFilters();
  const client = await pool.connect();
  await ensureTechnologiesColumn(client);

  let newlyInserted = 0;
  let alreadyExisted = 0;
  let skippedSenior = 0;
  let fetchFailed = 0;

  try {
    const foundUrls = [];
    for (const catUrl of CATEGORY_URLS) {
      let html;
      try {
        await sleep(1000);
        html = await fetchText(catUrl);
      } catch (err) {
        fetchFailed++;
        console.error(`[valorebasis] fetch failed ${catUrl}: ${err.message}`);
        continue;
      }

      const jobs = extractJobs(html, catUrl);
      console.log(`[valorebasis] ${catUrl.split("/").pop()} → ${jobs.length} active jobs`);

      for (const job of jobs) {
        if (shouldSkipTitleFilter(job.title, _filters) || shouldSkipSeniorExperience(isSeniorExperience(job.experience))) {
          skippedSenior++;
          console.log(`[valorebasis] SKIP senior "${job.title}"`);
          continue;
        }
        const wasNew = await upsertJob(client, "valorebasis", job);
        foundUrls.push(job.url);
        if (wasNew) {
          newlyInserted++;
          console.log(`[valorebasis] NEW "${job.title}" exp=${job.experience} → ${job.url}`);
        } else {
          alreadyExisted++;
          console.log(`[valorebasis] EXISTS "${job.title}"`);
        }
      }
    }

    console.log(
      `[valorebasis] DONE — new=${newlyInserted}, existed=${alreadyExisted}, skipped_senior=${skippedSenior}, fetch_failed=${fetchFailed}`
    );

    // The synthetic title-hash URL is deterministic per title+category, so it's
    // just as stable a row identity as a real per-posting URL — reconcile is
    // safe. (Previously skipped on the assumption the 404-sweep covered this
    // source instead; live-verified 2026-07-08 that it does NOT, because the
    // site ignores the query string and always answers 200 regardless of
    // whether that specific posting is still listed.)
    const rc = await reconcileActive(client, "valorebasis", foundUrls, { complete: fetchFailed === 0 });
    console.log(`[valorebasis] active reconcile — complete=${fetchFailed === 0}, ${JSON.stringify(rc)}`);
  } finally {
    client.release();
  }
});
