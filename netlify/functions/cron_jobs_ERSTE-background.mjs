/*
  Erste Bank karrier oldal scraper
  API: POST https://karrier.erstebank.hu/jsbq (same platform as K&H/Raiffeisen)
  Filter: specialities[]=IT, Biztonságmenedzsment és Digitalizáció & locations[]=Budapest

  Flow:
    1. POST API with pagination
    2. Parse row HTML — list contains experience field directly
    3. Senior: experience contains "5 év fölött" or "vezető" (without junior/medior values)
              OR isSeniorLike(title)
    4. Intern: experience contains "Gyakornok" or "pályakezdő" OR isInternshipTitle(title)
*/

import { Pool } from "pg";
import https from "https";
import http from "http";
import zlib from "zlib";
import { load as cheerioLoad } from "cheerio";
import { loadFilters } from "./load_filters.mjs";
import { logFetchError, withTimeout } from "./_error-logger.mjs";
import { reconcileActive, migrateVolatileUrl, escapeRegex } from "./_active_core.mjs";
import { isInternshipTitle, isSeniorExperience } from "./_experience_core.mjs";

let _filters = [];

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

const BASE = "https://karrier.erstebank.hu";
const API = `${BASE}/jsbq`;
// NOTE: Erste uses `locations[]` (not `cities[]` like K&H/Raiffeisen)
const FILTER_Q = "specialities[]=IT, Biztonságmenedzsment és Digitalizáció&locations[]=Budapest&";

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

// /allas/{slug}-{id} — the trailing numeric id ROTATES when the posting is
// refreshed (DB evidence: …banki-alapfolyamatok-squad-8827 → -8866), so the url
// alone can't be the row identity. Pattern matches the same slug under any id.
function volatileUrlPattern(url) {
  const m = url.match(/^(.*)-\d+$/);
  return m ? `^${escapeRegex(m[1])}-\\d+$` : null;
}

// The OPPOSITE churn also happens: the id stays put but the slug text changes
// (a title edit re-slugs the posting) — live evidence 2026-07-22: "frontend-
// fejleszto-8899" got re-slugged to "frontend-fejleszto-rendszeres-
// megtakaritasok-es-biztositasok-squad-8899" (same trailing id, longer title).
// volatileUrlPattern's fixed-prefix match can't catch this (the prefix changed
// too), so it silently orphaned the old row instead of migrating it — the old
// url stayed reachable (HTTP 200) but fell out of the listing and aged off as
// "Lejárt" while a separate new row got created for what a user sees as the
// same job. Fallback: match ANY erste url ending in the same numeric id,
// regardless of prefix.
function idOnlyPattern(url) {
  const m = url.match(/-(\d+)$/);
  return m ? `-${m[1]}$` : null;
}

function _blacklistRegex(k) {
  const escaped = normalizeText(k).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i");
}

function isSeniorLike(title) {
  const n = normalizeText(title ?? "");
  return _filters.some((kw) => _blacklistRegex(kw).test(n));
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

// Ugyanaz a jsbq lapozási csapda, mint a K&H-nál és a Raiffeisennél: a `page`
// KÜLÖN form-mezőként némán hatástalan, csak a `q` stringen BELÜL működik,
// 1-alapú indexeléssel. (Élő mérés 2026-08-21: page=2 külön mezőként ugyanazt a
// 8 sort adta, a q-n belül 0-t — mert összesen 8 állás van.)
// Itt most LAPPANGÓ a hiba (8 sor < 20-as oldalméret), de a platform ugyanaz.
async function fetchPage(page) {
  const q = `${FILTER_Q}page=${page}`;
  const body = `sRoute=public_job_esearch&q=${encodeURIComponent(q)}`;
  const text = await postForm(API, body);
  return JSON.parse(text);
}

/* ── db ──────────────────────────────────────────────────────── */

async function upsertJob(client, source, item) {
  const res = await client.query(
    `INSERT INTO job_posts (source, title, url, experience, first_seen)
     VALUES ($1,$2,$3,$4,NOW())
     ON CONFLICT (source, url) DO NOTHING
     RETURNING id;`,
    [source, item.title, item.url, item.experience ?? "-"]
  );
  return res.rowCount > 0;
}

/* ── handler ─────────────────────────────────────────────────── */

export default withTimeout("cron_jobs_ERSTE-background", async () => {
  _filters = await loadFilters();
  const client = await pool.connect();
  try {
    let crawlError = false;
    const foundUrls = [];
    const allRows = [];
    let page = 1; // 1-alapú, lásd fetchPage
    let total = 0;
    let maxPagesLeft = 25; // safety: ha a `total` hazudik, ne pörögjön végtelenül

    do {
      let res;
      try {
        res = await fetchPage(page);
      } catch (err) {
        await logFetchError("cron_jobs_ERSTE-background", { url: API, message: err.message });
        console.error(`[erste] page ${page} fetch failed: ${err.message}`);
        crawlError = true;
        break;
      }
      total = res.total || 0;
      const rows = Array.isArray(res.rows) ? res.rows : [];
      console.log(`[erste] page ${page}: ${rows.length} jobs (total=${total})`);
      allRows.push(...rows);
      if (rows.length === 0) break;
      page++;
      if (--maxPagesLeft <= 0) {
        // Csonka lista nem mehet teljesként a reconcile-ba.
        console.warn(`[erste] oldal-cap kimerült (allRows=${allRows.length}, total=${total}) → complete=false`);
        crawlError = true;
        break;
      }
    } while (allRows.length < total);

    const seen = new Set();
    const dedup = [];
    for (const r of allRows) {
      if (!r.url || seen.has(r.url)) continue;
      seen.add(r.url);
      dedup.push(r);
    }
    console.log(`[erste] total unique rows: ${dedup.length}`);

    // Full current listing (pre-filter) — a url in this set is live on the
    // source, so migrateVolatileUrl must never rename its row away.
    const currentUrls = dedup.map((r) => `${BASE}${r.url}`);

    let newlyInserted = 0;
    let migratedUrls = 0;
    let alreadyExisted = 0;
    let skippedSenior = 0;
    let skippedNoTitle = 0;
    let notBudapest = 0;

    for (const row of dedup) {
      try {
        const $ = cheerioLoad(row.row || "");
        const title = normalizeWhitespace($(".jobList__item__title").first().text());
        const city = normalizeWhitespace($(".job_list_city").first().text());
        const expValues = $(".job_list_experiences")
          .map((_, el) => normalizeWhitespace($(el).text()))
          .get()
          .filter(Boolean);
        const expCombined = expValues.join(" ");
        const url = `${BASE}${row.url}`;

        if (!title) {
          skippedNoTitle++;
          console.log(`[erste] SKIP no-title → ${url}`);
          continue;
        }
        if (city && !city.toLowerCase().includes("budapest")) {
          notBudapest++;
          console.log(`[erste] SKIP not-Budapest "${title}" city="${city}" → ${url}`);
          continue;
        }

        // Csak a cím-denylist dob (isSeniorLike) — uniform, mint MINDEN scrapernél
        // (user-döntés 2026-07-20). Az explicit tapasztalat-sáv ("5 év fölött")
        // NEM dob többé: elmentjük, az experience az expCombined marad (pl.
        // "5 év fölött" → a frontend badge évszám alapján jelöli).
        if (isSeniorLike(title)) {
          skippedSenior++;
          console.log(`[erste] SKIP senior "${title}" → ${url}`);
          continue;
        }

        // 2026-07-20-i refaktor törölte ezt a sort (a vele együtt eltávolított
        // seniorOnly logika tartotta fenn), de az isIntern lentebb továbbra is
        // rá hivatkozott → ReferenceError MINDEN nem-senior sornál, azóta a
        // teljes forrás új sort nem tudott felvenni (2026-07-22 user-jelzés).
        const expLower = expCombined.toLowerCase();
        const isIntern =
          expLower.includes("gyakornok") ||
          expLower.includes("pályakezdő") ||
          expLower.includes("palyakezdo") ||
          isInternshipTitle(title);

        let source = "erste";
        let experience = isIntern ? "diákmunka" : expCombined || "-";

        // Ideiglenes felülírás (2026-08-01, user-döntés): a fenti 07-20-as "csak
        // cím-denylist dob" szabály mellett most az experience-alapú senior-flag
        // is kizár insert előtt.
        if (isSeniorExperience(experience)) {
          skippedSenior++;
          console.log(`[erste] SKIP senior-experience [${experience}] "${title}" → ${url}`);
          continue;
        }

        const pattern = volatileUrlPattern(url);
        let migrated = pattern
          ? await migrateVolatileUrl(client, source, url, pattern, currentUrls)
          : false;
        if (!migrated) {
          const idPattern = idOnlyPattern(url);
          if (idPattern) migrated = await migrateVolatileUrl(client, source, url, idPattern, currentUrls);
        }
        const wasNew = await upsertJob(client, source, { title, url, experience });
        foundUrls.push(url);
        if (migrated) {
          migratedUrls++;
          console.log(`[erste] MIGRATED [${source}] "${title}" → ${url}`);
        } else if (wasNew) {
          newlyInserted++;
          console.log(`[erste] NEW [${source}] "${title}" exp=${experience} → ${url}`);
        } else {
          alreadyExisted++;
          console.log(`[erste] EXISTS [${source}] "${title}" → ${url}`);
        }
      } catch (err) {
        console.error(`[erste] row parse failed: ${err.message}`);
      }
    }

    console.log(
      `[erste] DONE — total=${dedup.length}, new=${newlyInserted}, migrated=${migratedUrls}, existed=${alreadyExisted}, ` +
      `skipped_senior=${skippedSenior}, skipped_no_title=${skippedNoTitle}, not_budapest=${notBudapest}`
    );

    const complete = !crawlError;
    const rc = await reconcileActive(client, "erste", foundUrls, { complete });
    console.log(`[erste] active reconcile — complete=${complete}, ${JSON.stringify(rc)}`);

  } finally {
    client.release();
  }
});
