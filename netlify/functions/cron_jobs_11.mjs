export const config = {
  schedule: "2 4-23 * * *",
};

import { Pool } from "pg";
import https from "https";
import http from "http";
import zlib from "zlib";
import { load as cheerioLoad } from "cheerio";

/* ---------------------
   DB connection
--------------------- */
const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

/* ---------------------
   Helper functions
--------------------- */
function normalizeText(s) {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeWhitespace(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

function titleNotBlacklisted(title) {
  const TITLE_BLACKLIST = [
    "marketing", "sales", "hr", "finance", "pénzügy", "könyvelő",
    "senior", "szenior", "medior", "Villamosmérnök ", "ipari", "Építészmérnök",
    "lead", "expert", "vezető fejlesztő", "tech lead"
  ];
  const t = normalizeText(title);
  return !TITLE_BLACKLIST.some((word) => t.includes(normalizeText(word)));
}

function dedupeByUrl(items) {
  const seen = new Set();
  return items.filter((x) => {
    if (!x.url) return false;
    const key = getDedupeKey(x.url);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/* =====================
   URL helpers
===================== */
function normalizeUrl(raw) {
  try {
    const u = new URL(raw);

    u.hash = "";
    [
      "utm_source", "utm_medium", "utm_campaign", "utm_term",
      "utm_content", "fbclid", "gclid", "trackingId", "pageNum", "position", "refId"
    ].forEach((p) => u.searchParams.delete(p));

    return u.toString().replace(/\?$/, "");
  } catch {
    return raw;
  }
}

/* ---------------------
   Fetch helper
--------------------- */
function fetchText(url, redirectLeft = 5) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;

    const req = lib.request(
      u,
      {
        method: "GET",
        headers: {
          "User-Agent": "JobWatcher/1.0",
          Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
          "Accept-Language": "hu-HU,hu;q=0.9,en;q=0.8",
          "Accept-Encoding": "gzip,deflate,br",
        },
        timeout: 50000,
      },
      (res) => {
        const code = res.statusCode || 0;

        if ([301, 302, 303, 307, 308].includes(code)) {
          const loc = res.headers.location;
          if (!loc) return reject(new Error(`HTTP ${code} (no Location) for ${url}`));
          if (redirectLeft <= 0) return reject(new Error(`Too many redirects for ${url}`));
          const nextUrl = new URL(loc, url).toString();
          res.resume();
          return resolve(fetchText(nextUrl, redirectLeft - 1));
        }

        const enc = String(res.headers["content-encoding"] || "").toLowerCase();
        let stream = res;
        if (enc.includes("gzip")) stream = res.pipe(zlib.createGunzip());
        else if (enc.includes("deflate")) stream = res.pipe(zlib.createInflate());
        else if (enc.includes("br")) stream = res.pipe(zlib.createBrotliDecompress());

        let data = "";
        stream.setEncoding("utf8");
        stream.on("data", (chunk) => (data += chunk));
        stream.on("end", () => {
          if (code >= 200 && code < 300) resolve(data);
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

/* ---------------------
   HTML extraction
--------------------- */
function extractCandidates(html, baseUrl) {
  const $ = cheerioLoad(html);

  const items = [];
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    const url = new URL(href, baseUrl).toString();
    if (!/^https?:\/\//i.test(url)) return;

    let card = $(el).closest("article, li, .job-list-item, .job, .position, .listing, .card, .item");
    if (!card.length) card = $(el).closest("div");

    const title =
      normalizeWhitespace($(el).text()) ||
      normalizeWhitespace(card.find("h1,h2,h3,h4,h5,h6").first().text());
    if (!title || title.length < 4) return;

    const desc = normalizeWhitespace(card.find("p").first().text()) || null;
    items.push({ title: title.slice(0, 300), url, description: desc ? desc.slice(0, 800) : null });
  });
  return dedupeByUrl(items);
}

function getDedupeKey(rawUrl) {
  return normalizeUrl(rawUrl);
}

function isFrissdiplomasJobUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.toLowerCase();
    return host.includes("frissdiplomas.hu") && u.pathname.startsWith("/allasok");
  } catch {
    return false;
  }
}

function isMatchingFrissdiplomasDetail(html) {
  const $ = cheerioLoad(html);

  // Preferred path from Frissdiplomas sidebar blocks.
  const directLocation = normalizeText(
    normalizeWhitespace(
      $(".job-sidebar-content h4")
        .filter((_, el) => normalizeText($(el).text()).includes("munkavegzes helye"))
        .first()
        .parent()
        .find("span")
        .first()
        .text()
    )
  );

  const directArea = normalizeText(
    normalizeWhitespace(
      $(".job-sidebar-content h4")
        .filter((_, el) => normalizeText($(el).text()).includes("allas terulete(i)"))
        .first()
        .parent()
        .find("span")
        .first()
        .text()
    )
  );

  if (directLocation || directArea) {
    const isBudapest = directLocation.includes("budapest");
    const isInformatikai = directArea.includes("informatikai");
    return isBudapest && isInformatikai;
  }

  // Fallback if structure changes.
  const pageText = normalizeText(normalizeWhitespace($("body").text()));
  const locationMarker = "munkavegzes helye";
  const areaMarker = "allas terulete(i)";

  const idxLocation = pageText.indexOf(locationMarker);
  const idxArea = pageText.indexOf(areaMarker);
  if (idxLocation === -1 || idxArea === -1) return false;

  const aroundLocation = pageText.slice(idxLocation, idxLocation + 220);
  const aroundArea = pageText.slice(idxArea, idxArea + 220);
  return aroundLocation.includes("budapest") && aroundArea.includes("informatikai");
}


/* ---------------------
   DB upsert
--------------------- */
async function upsertJob(client, source, item) {
  const canonicalUrl = item.url;

  await client.query(
    `INSERT INTO job_posts
      (source, title, url, canonical_url, first_seen)
     VALUES ($1,$2,$3,$4,NOW())
     ON CONFLICT (source, canonical_url)
        DO NOTHING;`,
    [source, item.title, item.url, canonicalUrl]
  );
}

function levelNotBlacklisted(title, desc) {
  const LEVEL_BLACKLIST = [
    "medior", "senior", "szenior", "szernior", "lead", "principal", "expert",
    "staff", "architect", "sr.", "sr ", "sen.",
    "experienced", "expertise"
  ];
  const t = normalizeText(`${title ?? ""} ${desc ?? ""}`);
  return !LEVEL_BLACKLIST.some((w) => t.includes(normalizeText(w)));
}

const FRISSDIPLOMAS_JOB_PREFIX = "https://www.frissdiplomas.hu/allasok";
const URL_BLACKLIST = new Set([
  normalizeUrl("https://www.frissdiplomas.hu/allasok"),
]);

export default async () => {
  const client = await pool.connect();

  try {
    async function processListingPage(html, sourceKey, baseUrl) {
      const rawItems = extractCandidates(html, baseUrl);

      const items = rawItems.filter((it) => {
        if (URL_BLACKLIST.has(normalizeUrl(it.url))) return false;
        if (!isFrissdiplomasJobUrl(it.url) && !it.url.startsWith(FRISSDIPLOMAS_JOB_PREFIX)) return false;
        if (!levelNotBlacklisted(it.title, it.description)) return false;
        if (!titleNotBlacklisted(it.title)) return false;
        return true;
      });

      for (const it of items) {
        try {
          let keep = true;

          if (sourceKey === "frissdiplomas") {
            const detailHtml = await fetchText(it.url);
            keep = isMatchingFrissdiplomasDetail(detailHtml);
          }

          if (!keep) continue;
          await upsertJob(client, sourceKey, it);
        } catch (err) {
          console.error(err);
        }
      }

      return items.length;
    }

    // Only process pages 1-4
    try {
      const firstHtml = await fetchText("https://www.frissdiplomas.hu/allasok");
      const count = await processListingPage(firstHtml, "frissdiplomas", "https://www.frissdiplomas.hu/allasok");
      console.log(`frissdiplomas page 1: ${count} items processed.`);
    } catch (err) {
      console.error("frissdiplomas fetch failed:", err.message);
    }

    // Pages 2-4 only
    for (let page = 2; page <= 3; page++) {
      const pageUrl = `https://www.frissdiplomas.hu/kereses/page:${page}`;
      try {
        const html = await fetchText(pageUrl);
        const count = await processListingPage(html, "frissdiplomas", pageUrl);
        console.log(`frissdiplomas page ${page}: ${count} items processed.`);
      } catch (err) {
        if (String(err?.message || "").includes("HTTP 404")) {
          console.log(`frissdiplomas pagination stopped at page ${page} (404).`);
          break;
        }
        console.error(`frissdiplomas page ${page} fetch failed:`, err.message);
        break;
      }
    }

  } finally {
    client.release();
  }

  return new Response("OK");
};
