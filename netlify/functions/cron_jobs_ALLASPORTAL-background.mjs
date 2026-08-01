/*
  Állásportál (allasportal.hu) – Budapest+Informatika scraper

  Kutatási jegyzet: scripts/ALLASPORTAL_SCRAPE_RESEARCH.md (2026-07-11 élő próbák)

  🚫 ELENGEDVE (user-döntés 2026-07-11, workcenter-minta) — PROD-BLOKK miatt:
  a site CLOUDFLARE mögött van (`Server: cloudflare`), és a Netlify (AWS Lambda)
  datacenter IP-jét 403-mal tiltja MÁR AZ ELSŐ oldalon. Lakossági IP-ről (dry-run)
  MINDEN 200 — akár default curl-UA-val, cache-buszterrel is —, tehát IP/ASN-szintű
  blokk, header/UA-tuning BIZTOSAN nem segít (a kliens már böngésző-UA-t küld).
  Ugyanaz az osztály, mint a workcenternél. A parse/lapozás/extrakció maga KÉSZ és
  lokálisan igazolt (lásd a kutatási jegyzet dry-run szakaszát) — csak a prod-fetch
  bukik a Cloudflare-IP-blokkon. A fájl megmarad; ha egyszer lesz proxy /
  nem-datacenter host, a `cron_scheduler.mjs` GRID-jébe 1 sor felvétele elég.
  (Amíg nem fut: reconcile üres foundUrls → skip, meglévő sort nem deaktivál.)

  Forrás: a HR Portal / CVOnline hálózat aggregátora. Klasszikus szerver-renderelt
  PHP; alkalmazás-szintű bot-védelem nincs, de a Cloudflare-réteg IP-alapon blokkol. Szelet (user-döntés 2026-07-11): KÖTELEZŐEN Budapest+IT,
  azaz /v-budapest/k-informatika/ — ez a site saját teljes kategória-listázása
  (nem kereső-nézet), így a szelet bejárása a forrás teljes listájának számít és
  a reconcile teljes jogú deaktivátor lehet.

  Lapozás: ?page=N (15 kártya/oldal); az utolsó oldal számát a pager
  `a.last` linkje adja; a lapszámon túli oldal 200-zal jön, de 0 kártyával.

  Két kártyatípus (data-jobtype):
    • "jobshow"  → belső /munka-<slug>/ detail (teljes leírás, cookie nem kell);
      lejárt hirdetésnél SOFT-404: HTTP 200 + "Ez az álláshirdetés lejárt" h1.
    • "redirect" → /munka/redirect/<id> → 302 külső célra (a mintázott szeleten
      mind cvonline.hu). A redirect-URL a sor identitása (stabil numerikus id,
      navigálható); HALOTT id tiszta HTTP 404-et ad, így a 404-sweep ezeket
      magától is fogja. A cvonline listing-lag miatti sweep↔reconcile
      flip-flopot a STICKY_SWEEP_DEAD_SOURCES tagság fogja meg (_active_core).

  A detail-fetch (belső VAGY redirecten át cvonline) insert ELŐTT fut
  (experience-write-policy), és kézi redirect-követéssel megy a latin1 Location
  gotcha fixszel (alllocaljobs-minta) — az allasportal PHP+UTF-8, egy ékezetes
  Location azonnal mojibake-404 lenne naiv követéssel.
*/

import { Pool } from "pg";
import { load as cheerioLoad } from "cheerio";
import { loadFilters } from "./load_filters.mjs";
import { logFetchError, withTimeout } from "./_error-logger.mjs";
import { reconcileActive } from "./_active_core.mjs";
import { isBlockedCompany } from "./_company_blocklist.mjs";
import {
  isInternshipTitle, isJuniorTitle, isMidLevelTitle,
  extractBodyExperience, extractTechnologies, ensureTechnologiesColumn,
  isSeniorExperience,
} from "./_experience_core.mjs";

let _filters = [];

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

const BASE = "https://allasportal.hu";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// Szeletek — mind a site saját kategória-listázása (nem kereső), bővíthető.
// 2026-07-11: Budapest+IT = 12 oldal ≈ 180 állás.
const SLICES = ["v-budapest/k-informatika"];
const pageUrl = (slice, page) =>
  `${BASE}/${slice}/` + (page > 1 ? `?page=${page}` : "");

// 15 kártya/oldal; most 12 oldal a szelet. A cap parser-/pager-hiba elleni
// védelem — ha az a.last ennél többet mondana, a walk complete=false-szal áll
// le, hogy ne deaktiváljon tévesen.
const MAX_LIST_PAGES = 30;

/* ── helpers ─────────────────────────────────────────────────── */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizeWhitespace(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

function normalizeText(s) {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeUrl(raw) {
  try {
    const u = new URL(raw, BASE);
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
  const n = normalizeText(title);
  return _filters.some((k) => _blacklistRegex(k).test(n));
}

/* ── fetch ───────────────────────────────────────────────────── */

// undici a Location nyers UTF-8 bájtjait latin1-ként adja → naiv new URL()
// dupla-encode-ol és 404 lesz; a latin1→utf8 roundtrip helyreállítja, érvénytelen
// UTF-8 (U+FFFD) esetén marad az eredeti. (alllocaljobs / 404sweep minta.)
function fixLocationEncoding(loc) {
  const decoded = Buffer.from(loc, "latin1").toString("utf8");
  return decoded.includes("�") ? loc : decoded;
}

// Kézi redirect-követés (cookie nem kell ehhez a site-hoz): a /munka/redirect/<id>
// külső célra (cvonline) 302-zik, a body onnan jön.
export async function fetchFinal(url) {
  let current = url;
  for (let hop = 0; hop < 6; hop++) {
    const res = await fetch(current, {
      redirect: "manual",
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "hu-HU,hu;q=0.9,en;q=0.8",
      },
      signal: AbortSignal.timeout(25000),
    });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get("location");
      if (!loc) throw new Error(`HTTP ${res.status} (no Location) for ${current}`);
      current = new URL(fixLocationEncoding(loc), current).toString();
      continue;
    }
    const body = await res.text();
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`HTTP ${res.status} for ${current}`);
    }
    return { body, finalUrl: current };
  }
  throw new Error(`Too many redirects for ${url}`);
}

/* ── extraction ─────────────────────────────────────────────── */

// div.card → a.pos[data-job] a hirdetés linkje (jobshow: /munka-<slug>/,
// redirect: /munka/redirect/<id>); cég a .comp-logo h2-ben. Ami nem passzol a
// két URL-mintára (pl. promó-kártya külső linkkel), kiesik.
// (parseCards/parseLastPage/fetchFinal exportálva a DB nélküli dry-run teszthez.)
export function parseCards(html) {
  const $ = cheerioLoad(html);
  const items = [];
  $("div.card").each((_, el) => {
    const $c = $(el);
    const $pos = $c.find("a.pos[data-job]").first();
    if (!$pos.length) return;

    const url = normalizeUrl($pos.attr("href") || "");
    if (!/^https:\/\/allasportal\.hu\/(munka-[^/]+\/|munka\/redirect\/\d+)$/.test(url)) return;

    const title = normalizeWhitespace($pos.text());
    if (!title || title.length < 4) return;

    const company =
      normalizeWhitespace($c.find(".comp-logo h2").first().text()) || null;

    items.push({
      url,
      title: title.slice(0, 300),
      company: company ? company.slice(0, 200) : null,
      jobtype: $pos.attr("data-jobtype") || "",
    });
  });
  return items;
}

// A pager `a.last` linkjéből az utolsó oldalszám; ha nincs pager (≤15 találat),
// 1 oldal a szelet.
export function parseLastPage(html) {
  const $ = cheerioLoad(html);
  const href = $("a.last").first().attr("href") || "";
  const m = href.match(/[?&](?:amp;)?page=(\d+)/);
  if (m) return parseInt(m[1], 10);
  let max = 1;
  $("a.page").each((_, el) => {
    const pm = ($(el).attr("href") || "").match(/[?&](?:amp;)?page=(\d+)/);
    if (pm) max = Math.max(max, parseInt(pm[1], 10));
  });
  return max;
}

// Lejárt hirdetés belső detail-oldala SOFT-404: HTTP 200, de a h1 mondja meg.
function isExpiredDetail(body) {
  return /<h1[^>]*>\s*Ez az álláshirdetés lejárt/i.test(body);
}

/* ── db ──────────────────────────────────────────────────────── */

// Nofluffjobs/alllocaljobs-minta: az experience csak a '-'/üres/NULL sorokat
// tölti ki most fetchelt valós értékkel (korábbi sikertelen detail-fetch a
// következő scrape-nél gyógyul), a technologies akkor töltődik, ha eddig NULL
// volt, a company a hiányzót pótolja.
async function upsertJob(client, item) {
  await client.query(
    `INSERT INTO job_posts
      (source, title, url, experience, company, technologies, first_seen)
     VALUES ($1,$2,$3,$4,$5,$6,NOW())
     ON CONFLICT (source, url) DO UPDATE SET
        experience = CASE
          WHEN (job_posts.experience IS NULL OR job_posts.experience IN ('-', ''))
           AND EXCLUDED.experience NOT IN ('-', '')
          THEN EXCLUDED.experience ELSE job_posts.experience END,
        technologies = COALESCE(job_posts.technologies, EXCLUDED.technologies),
        company = CASE
          WHEN job_posts.company IS NULL THEN EXCLUDED.company
          ELSE job_posts.company END
        WHERE ((job_posts.experience IS NULL OR job_posts.experience IN ('-', ''))
               AND EXCLUDED.experience NOT IN ('-', ''))
           OR (job_posts.technologies IS NULL AND EXCLUDED.technologies IS NOT NULL)
           OR (job_posts.company IS NULL AND EXCLUDED.company IS NOT NULL);`,
    ["allasportal", item.title, item.url, item.experience ?? "-", item.company || null, item.technologies ?? null]
  );
}

/* ── main scrape ─────────────────────────────────────────────── */

// Egy szelet teljes bejárása. complete csak akkor, ha az 1. oldal pagere
// elhitte magát (lastPage ≤ cap) ÉS minden oldal hiba nélkül, ≥1 kártyával
// jött — egy csendben eltörő selector/pager így nem tud mass-deactivate-et
// okozni (F1).
async function walkSlice(slice) {
  const items = [];

  let firstBody;
  try {
    ({ body: firstBody } = await fetchFinal(pageUrl(slice, 1)));
  } catch (err) {
    await logFetchError("cron_jobs_ALLASPORTAL-background", { url: pageUrl(slice, 1), message: err.message });
    console.error(`[allasportal] ${slice} page 1 failed: ${err.message}`);
    return { items, complete: false };
  }

  const lastPage = parseLastPage(firstBody);
  const cards1 = parseCards(firstBody);
  console.log(`[allasportal] ${slice} page 1/${lastPage}: ${cards1.length} cards`);
  items.push(...cards1);
  if (cards1.length === 0) return { items, complete: false };
  if (lastPage > MAX_LIST_PAGES) {
    console.warn(`[allasportal] ${slice} pager claims ${lastPage} pages (cap ${MAX_LIST_PAGES}) — INCOMPLETE`);
    return { items, complete: false };
  }

  for (let page = 2; page <= lastPage; page++) {
    await sleep(500);
    try {
      const { body } = await fetchFinal(pageUrl(slice, page));
      const cards = parseCards(body);
      console.log(`[allasportal] ${slice} page ${page}/${lastPage}: ${cards.length} cards`);
      if (cards.length === 0) {
        console.warn(`[allasportal] ${slice} page ${page} parsed 0 cards — INCOMPLETE`);
        return { items, complete: false };
      }
      items.push(...cards);
    } catch (err) {
      await logFetchError("cron_jobs_ALLASPORTAL-background", { url: pageUrl(slice, page), message: err.message });
      console.error(`[allasportal] ${slice} page ${page} failed: ${err.message}`);
      return { items, complete: false };
    }
  }

  return { items, complete: true };
}

async function scrapeAllasportal(client) {
  const seen = new Set();
  const allItems = [];
  const foundUrls = [];

  // BÁRMELYIK szelet hibája → complete=false, mert a hiányzó szelet állásai
  // tévesen deaktiválódnának (DIAK_3 allSucceeded-minta).
  let allComplete = true;
  for (const slice of SLICES) {
    const { items, complete } = await walkSlice(slice);
    allItems.push(...items);
    if (!complete) allComplete = false;
    await sleep(500);
  }

  if (allItems.length === 0) {
    console.error("[allasportal] no cards from ANY slice — skipping upsert+reconcile");
    return;
  }

  // F3-védelem: a foundUrls a TELJES listát kapja (senior-/cégszűrés előtt!),
  // hogy egy blacklist-változás miatt kieső, de még élő állás ne deaktiválódjon.
  let newlyInserted = 0;
  let alreadyExisted = 0;
  let skippedSenior = 0;
  let skippedCompany = 0;

  // url → tárolt experience; detail-fetch csak oda megy, ahol a DB-ben még
  // nincs valós érték — nincs külön backfill, a scrape gyógyít.
  const { rows: knownRows } = await client.query(
    `SELECT url, experience FROM job_posts WHERE source = 'allasportal'`
  );
  const known = new Map(knownRows.map((r) => [r.url, r.experience]));
  const needsDetail = (url) => {
    if (!known.has(url)) return true;
    const exp = known.get(url);
    return exp == null || exp === "-" || exp === "";
  };

  for (const item of allItems) {
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    foundUrls.push(item.url);

    if (isSeniorLike(item.title)) {
      skippedSenior++;
      continue;
    }

    if (isBlockedCompany(item.company, "allasportal")) {
      skippedCompany++;
      continue;
    }

    // A sor TELJESEN felépül insert ELŐTT (fetch-before-insert szabály):
    // cím-rövidzár, különben detail-fetch a body-alapú szinthez + technológiákhoz.
    // Redirect-típusnál a body a redirect-cél (cvonline) oldala.
    item.experience = isInternshipTitle(item.title) ? "diákmunka"
      : isJuniorTitle(item.title) ? "junior"
      : isMidLevelTitle(item.title) ? "medior"
      : "-";

    if (needsDetail(item.url) && item.experience === "-") {
      try {
        await sleep(400);
        const { body } = await fetchFinal(item.url);
        if (item.jobtype === "jobshow" && isExpiredDetail(body)) {
          // listing-lag: a lista még hozza, a detail már lejártat mond —
          // nem extraktálunk, a reconcile/következő futás rendezi
          console.log(`[allasportal] expired-on-detail (listing lag): ${item.url}`);
        } else {
          item.experience = extractBodyExperience(body) || "-";
          item.technologies = extractTechnologies(body);
        }
      } catch (err) {
        await logFetchError("cron_jobs_ALLASPORTAL-background", { url: item.url, message: `detail: ${err.message}` });
      }
    }

    if (isSeniorExperience(item.experience)) {
      skippedSenior++;
      continue;
    }

    if (known.has(item.url)) {
      alreadyExisted++;
    } else {
      newlyInserted++;
      console.log(`[allasportal] NEW [${item.experience}] "${item.title}" (${item.company ?? "?"}, ${item.jobtype})`);
    }
    await upsertJob(client, item);
  }

  console.log(
    `[allasportal] DONE — new=${newlyInserted}, existed=${alreadyExisted}, ` +
    `skipped_senior=${skippedSenior}, skipped_company=${skippedCompany}, unique=${foundUrls.length} ` +
    `(raw=${allItems.length}, slices_complete=${allComplete})`
  );

  const rc = await reconcileActive(client, "allasportal", foundUrls, { complete: allComplete });
  console.log(`[allasportal] active reconcile — complete=${allComplete}, ${JSON.stringify(rc)}`);
}

/* ── handler ─────────────────────────────────────────────────── */

const _runJob = withTimeout("cron_jobs_ALLASPORTAL-background", async () => {
  _filters = await loadFilters();
  const client = await pool.connect();
  try {
    await ensureTechnologiesColumn(client);
    await scrapeAllasportal(client);
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
