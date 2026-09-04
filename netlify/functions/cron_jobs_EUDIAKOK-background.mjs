/*
  euDiákok – Pest megye / Informatikai és mérnöki munkák scraper

  List URL:
    https://www.eudiakok.hu/diakmunka.php?kulcsszo=&szures_megye=5&munka_fajta=23

  Flow:
    1. Fetch list page → extract /diakmunka/{slug}-{ID} job links
    2. Fetch each detail page
    3. Parse "MUNKAVÉGZÉS HELYE" label → skip if not Budapest
       (szures_megye=5 = Pest megye, includes non-Budapest towns)
    4. extractBodyExperience → experience field
    5. Senior filter via _filters
    6. Upsert to job_posts (source = "eudiakok")
*/

import { Pool } from "pg";
import https from "https";
import http from "http";
import zlib from "zlib";
import { load as cheerioLoad } from "cheerio";
import { loadFilters } from "./load_filters.mjs";
import { withTimeout } from "./_error-logger.mjs";
import { reconcileActive } from "./_active_core.mjs";
import { extractBodyExperience, extractTechnologies, ensureTechnologiesColumn, ensureLevelColumn, isInternshipTitle, isSeniorExperience } from "./_experience_core.mjs";
import { shouldSkipTitleFilter, shouldSkipSeniorExperience, seniorAwareExperience } from "./_seniority_policy.mjs";
import { computeLevel } from "../../src/lib/experienceLevel.mjs";

let _filters = [];

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

const BASE = "https://www.eudiakok.hu";
const LIST_URL = `${BASE}/diakmunka.php?kulcsszo=&szures_megye=5&munka_fajta=23`;

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

/* ── list page parser ────────────────────────────────────────── */

function extractJobLinks(html, baseUrl) {
  const $ = cheerioLoad(html);
  const links = new Set();

  // Detail URL pattern: /diakmunka/{slug}-{ID}  (numeric id at end of slug)
  $("a[href]").each((_, el) => {
    const raw = $(el).attr("href");
    if (!raw) return;
    try {
      const full = new URL(raw, baseUrl).toString();
      const path = new URL(full).pathname;
      // Match /diakmunka/{slug}-{NNNN} but exclude the listing /diakmunka and /diakmunkak/* index pages
      if (/^\/diakmunka\/[a-z0-9][a-z0-9-]*-\d+\/?$/i.test(path)) {
        links.add(normalizeUrl(full));
      }
    } catch {
      // ignore malformed
    }
  });

  return [...links];
}

/* ── detail page parser ──────────────────────────────────────── */

// Budapest-e a helyszín? A puszta `includes("budapest")` 2026-08-21-ig 3 élő MBH
// gyakornoki hirdetést dobott el némán, mert a "MUNKAVÉGZÉS HELYE" mező nem
// mindig írja ki a város nevét:
//
//   "XI. kerület, Infopark - Magyar Tudósok krt. 9."  → csak kerület
//   "1116 Bp., Kalotaszeg u. 31."                     → rövidítve
//   "1138 Budapest, Váci út 193."                     → ez volt az egyetlen, ami átment
//
// Egyértelmű jelek: a "budapest" szó, a "bp" rövidítés, és a budapesti
// irányítószám (1011-1239 → minden 1-essel kezdődő négyjegyű).
//
// A puszta "N. kerület" SZÁNDÉKOSAN nem szerepel itt: Debrecennek, Miskolcnak,
// Győrnek és Pécsnek is vannak kerületei, úgyhogy önmagában félrevezető. Azokat
// az eseteket a JSON-LD addressRegion fedi le (lásd extractJsonLdLocation),
// ami kimondottan "Budapest"-et ír — nem kell hozzá találgatnunk.
function isBudapestLocation(text) {
  const t = String(text || "").toLowerCase();
  if (!t) return false;
  if (/\bbudapest/.test(t)) return true;
  if (/\bbp\b|\bbp\./.test(t)) return true;
  if (/\b1[0-2]\d{2}\b/.test(t)) return true; // budapesti irányítószám
  return false;
}

// A hirdetések többsége visz egy schema.org JobPosting JSON-LD blokkot, amiben a
// helyszín STRUKTURÁLTAN szerepel (addressLocality / addressRegion). Ez sokkal
// megbízhatóbb, mint a látható címke szövegét visszafejteni — a fenti két
// kerület-only hirdetésnél is tisztán "Budapest" az addressRegion.
// Nem minden oldalon van (8-ból 2-n hiányzik), ezért csak ELSŐDLEGES forrás,
// nem kizárólagos.
function extractJsonLdLocation(html) {
  const parts = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    let data;
    try {
      data = JSON.parse(m[1]);
    } catch {
      continue; // törött JSON-LD nem ok a futás megszakítására
    }
    for (const node of Array.isArray(data) ? data : [data]) {
      const jl = node?.jobLocation;
      if (!jl) continue;
      for (const place of Array.isArray(jl) ? jl : [jl]) {
        const a = place?.address || {};
        parts.push(a.addressLocality, a.addressRegion, a.postalCode, place?.name);
      }
    }
  }
  return parts.filter(Boolean).join(" | ");
}

// Returns { title, experience } or null if not Budapest
function parseDetailPage(html) {
  const $ = cheerioLoad(html);

  // Locate "MUNKAVÉGZÉS HELYE" heading and its following sibling text
  let location = "";
  $("h5, h4, h3").each((_, el) => {
    const heading = normalizeText($(el).text());
    if (heading.includes("munkavegzes helye")) {
      // Try multiple strategies for the value: next sibling, parent's next, surrounding text
      const next = $(el).next();
      const nextText = next.length ? normalizeWhitespace(next.text()) : "";
      if (nextText) {
        location = nextText;
      } else {
        // fallback: parent text minus heading
        const parentText = normalizeWhitespace($(el).parent().text());
        location = parentText.replace($(el).text(), "").trim();
      }
    }
  });

  // Fallback: scan body for "MUNKAVÉGZÉS HELYE" label inline
  if (!location) {
    const bodyText = normalizeWhitespace($("body").text());
    const m = bodyText.match(/munkav[eé]gz[eé]s\s+helye\s*:?\s*([^\n|]{1,80})/i);
    if (m) location = m[1].trim();
  }

  // A látható címke és a strukturált JSON-LD EGYÜTT dönt: elég, ha bármelyik
  // Budapestre mutat. (A JSON-LD-t akkor is megnézzük, ha a címke-parse adott
  // értéket — pont a "XI. kerület, Infopark…" eset az, ahol a címke szövege
  // önmagában nem árulja el a várost.)
  const jsonLdLocation = extractJsonLdLocation(html);
  if (!isBudapestLocation(location) && !isBudapestLocation(jsonLdLocation)) return null;

  const title = normalizeWhitespace($("h1").first().text());
  const experience = isInternshipTitle(title)
    ? "diákmunka"
    : extractBodyExperience(html);
  const technologies = extractTechnologies(html);

  return { title, experience, technologies };
}

/* ── db ──────────────────────────────────────────────────────── */

async function upsertJob(client, source, item) {
  const experience = seniorAwareExperience(item.title, item.experience) ?? "-";
  const res = await client.query(
    `INSERT INTO job_posts (source, title, url, experience, technologies, level, first_seen)
     VALUES ($1,$2,$3,$4,$5,$6,NOW())
     ON CONFLICT (source, url) DO NOTHING
     RETURNING id;`,
    [source, item.title, item.url, experience, item.technologies ?? null, computeLevel({ title: item.title, experience, source })]
  );
  return res.rowCount > 0;
}

/* ── handler ─────────────────────────────────────────────────── */

export default withTimeout("cron_jobs_EUDIAKOK-background", async () => {
  _filters = await loadFilters();
  const client = await pool.connect();
  await ensureTechnologiesColumn(client);
  await ensureLevelColumn(client);

  let listHtml;
  try {
    listHtml = await fetchText(LIST_URL);
  } catch (err) {
    console.error(`[eudiakok] list fetch failed: ${err.message}`);
    client.release();
    return;
  }

  const jobLinks = extractJobLinks(listHtml, BASE);
  console.log(`[eudiakok] list: ${jobLinks.length} links`);

  let newlyInserted = 0;
  let alreadyExisted = 0;
  let skippedSenior = 0;
  let skippedNoTitle = 0;
  let notBudapest = 0;
  let detailFetchFailed = 0;
  const foundUrls = [];

  try {
    for (const detailUrl of jobLinks) {
      try {
        await sleep(800);
        const html = await fetchText(detailUrl);
        const parsed = parseDetailPage(html);

        if (!parsed) {
          notBudapest++;
          console.log(`[eudiakok] SKIP not-Budapest → ${detailUrl}`);
          continue;
        }

        if (!parsed.title) {
          skippedNoTitle++;
          console.log(`[eudiakok] SKIP no-title → ${detailUrl}`);
          continue;
        }

        if (shouldSkipTitleFilter(parsed.title, _filters) || shouldSkipSeniorExperience(isSeniorExperience(parsed.experience))) {
          skippedSenior++;
          console.log(`[eudiakok] SKIP senior "${parsed.title}" → ${detailUrl}`);
          continue;
        }

        const wasNew = await upsertJob(client, "eudiakok", {
          title: parsed.title,
          url: detailUrl,
          experience: parsed.experience,
          technologies: parsed.technologies,
        });
        foundUrls.push(detailUrl);

        if (wasNew) {
          newlyInserted++;
          console.log(
            `[eudiakok] NEW "${parsed.title}" exp=${parsed.experience ?? "-"} → ${detailUrl}`
          );
        } else {
          alreadyExisted++;
          console.log(`[eudiakok] EXISTS "${parsed.title}" → ${detailUrl}`);
        }
      } catch (err) {
        // The job's EXISTENCE is proven by the list page (jobLinks); the detail
        // fetch only supplies title/experience. Still push the url to foundUrls,
        // otherwise a single flaky detail would let reconcile deactivate a live
        // job — and gating `complete` on detail failures (the old behavior)
        // blocked ALL deactivation whenever one detail hiccuped.
        detailFetchFailed++;
        foundUrls.push(detailUrl);
        console.error(`[eudiakok] detail fetch failed ${detailUrl}: ${err.message}`);
      }
    }

    console.log(
      `[eudiakok] DONE — total=${jobLinks.length}, new=${newlyInserted}, existed=${alreadyExisted}, ` +
      `skipped_senior=${skippedSenior}, skipped_no_title=${skippedNoTitle}, ` +
      `not_budapest=${notBudapest}, fetch_failed=${detailFetchFailed}`
    );

    // List fetch succeeded (we returned early otherwise), so the crawl is
    // complete: detail failures no longer threaten any listed job's row.
    const complete = true;
    // eudiakok regularly has ZERO open IT/Budapest student jobs — a legitimate
    // state, not a blocked crawl (the list fetch above provably succeeded). Without
    // emptyIsValid the empty-set guard makes its rows IMMORTAL: reconcile can never
    // deactivate them, and the sweep's redirect rule doesn't fire either because a
    // closed posting still answers 200 on its own path (2 rows were stuck active on
    // 2026-07-14). See ACTIVATION_AUDIT.md.
    const rc = await reconcileActive(client, "eudiakok", foundUrls, { complete, emptyIsValid: true });
    console.log(`[eudiakok] active reconcile — complete=${complete}, ${JSON.stringify(rc)}`);
  } finally {
    client.release();
  }
});
