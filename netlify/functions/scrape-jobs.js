// netlify/functions/scrape-jobs.js
const axios = require("axios");
const cheerio = require("cheerio");
const { Pool } = require("pg");

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL env var missing");

const SCRAPE_SECRET = process.env.SCRAPE_SECRET || "";

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

function json(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}

// ------------------ ÁLLÍTSD BE EZEKET ------------------
const SOURCES = [
  {
    key: "melodiak",
    listUrls: [
      // TODO: ide a konkrét listázó oldal
      "https://melodiak.hu/",
    ],
    parse: parseMelodiak,
  },
  {
    key: "minddiak",
    listUrls: [
      // TODO
      "https://minddiak.hu/",
    ],
    parse: parseMinddiak,
  },
  {
    key: "muisz",
    listUrls: [
      // TODO
      "https://muisz.hu/",
    ],
    parse: parseMuisz,
  },
];

// ------------------ HTTP ------------------
async function fetchHtml(url) {
  const res = await axios.get(url, {
    timeout: 25000,
    headers: {
      "User-Agent": "Mozilla/5.0 (JobWatcher/1.0)",
      "Accept-Language": "hu-HU,hu;q=0.9,en;q=0.8",
    },
  });
  return res.data;
}

function absolutizeUrl(href, baseUrl) {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

function normalizeWhitespace(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

// ------------------ PARSEREK (TODO: szelektorok) ------------------
// Itt kell majd beállítani a valós HTML szelektorokat a listázó oldalakhoz.

function parseMelodiak(html, baseUrl) {
  const $ = cheerio.load(html);

  // TODO: cseréld a szelektorokat:
  // Pl: $(".job-card").each(...)
  const items = [];

  $("a").each((_, el) => {
    const href = $(el).attr("href");
    const title = normalizeWhitespace($(el).text());
    if (!href || !title) return;

    // TODO: szűrés, hogy tényleg álláshirdetés legyen
    // if (!href.includes("/allas") && !href.includes("/job")) return;

    const url = absolutizeUrl(href, baseUrl);
    if (!url) return;

    items.push({ title: title.slice(0, 300), url, description: null });
  });

  return dedupeByUrl(items);
}

function parseMinddiak(html, baseUrl) {
  const $ = cheerio.load(html);
  const items = [];

  // TODO: valós szelektor
  $("a").each((_, el) => {
    const href = $(el).attr("href");
    const title = normalizeWhitespace($(el).text());
    if (!href || !title) return;

    const url = absolutizeUrl(href, baseUrl);
    if (!url) return;

    items.push({ title: title.slice(0, 300), url, description: null });
  });

  return dedupeByUrl(items);
}

function parseMuisz(html, baseUrl) {
  const $ = cheerio.load(html);
  const items = [];

  // TODO: valós szelektor
  $("a").each((_, el) => {
    const href = $(el).attr("href");
    const title = normalizeWhitespace($(el).text());
    if (!href || !title) return;

    const url = absolutizeUrl(href, baseUrl);
    if (!url) return;

    items.push({ title: title.slice(0, 300), url, description: null });
  });

  return dedupeByUrl(items);
}

function dedupeByUrl(items) {
  const seen = new Set();
  return items.filter((x) => {
    if (!x.url) return false;
    if (seen.has(x.url)) return false;
    seen.add(x.url);
    return true;
  });
}

// ------------------ DB UPSERT ------------------
async function upsertJob(client, source, item) {
  const { title, url, description } = item;
  await client.query(
    `INSERT INTO job_posts (source, title, url, description, first_seen, last_seen)
     VALUES ($1, $2, $3, $4, NOW(), NOW())
     ON CONFLICT (source, url)
     DO UPDATE SET
       title = EXCLUDED.title,
       description = COALESCE(EXCLUDED.description, job_posts.description),
       last_seen = NOW()`,
    [source, title, url, description]
  );
}

// ------------------ AUTH ------------------
function isScheduled(event) {
  const h = event.headers || {};
  // Netlify scheduled invocationsnál gyakran van ilyen jellegű header.
  // Ha nálad nem jön, akkor a schedule akkor is működik, csak ez false marad.
  return String(h["x-nf-scheduled"] || h["X-Nf-Scheduled"] || "").toLowerCase() === "true";
}

function isAuthorized(event) {
  if (isScheduled(event)) return true; // schedule mehet secret nélkül
  if (!SCRAPE_SECRET) return true;     // ha nem állítasz be secretet, akkor nyitott (nem ajánlott)
  const qs = event.queryStringParameters || {};
  const key = qs.key || "";
  const headerKey = (event.headers && (event.headers["x-scrape-secret"] || event.headers["X-Scrape-Secret"])) || "";
  return key === SCRAPE_SECRET || headerKey === SCRAPE_SECRET;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, x-scrape-secret",
      },
      body: "",
    };
  }

  if (!isAuthorized(event)) {
    return json(401, { ok: false, error: "Unauthorized. Missing/invalid key." });
  }

  const client = await pool.connect();
  try {
    let totalFound = 0;
    let totalUpserted = 0;

    for (const src of SOURCES) {
      for (const listUrl of src.listUrls) {
        const html = await fetchHtml(listUrl);
        const items = src.parse(html, listUrl);

        totalFound += items.length;

        for (const item of items) {
          if (!item.title || !item.url) continue;

          // minimális anti-noise: túl rövid címeket dobjuk
          if (item.title.length < 4) continue;

          await upsertJob(client, src.key, item);
          totalUpserted += 1;
        }
      }
    }

    return json(200, {
      ok: true,
      totalFound,
      totalUpserted,
      ranAt: new Date().toISOString(),
      scheduled: isScheduled(event),
    });
  } catch (err) {
    console.error(err);
    return json(500, { ok: false, error: err.message });
  } finally {
    client.release();
  }
};
