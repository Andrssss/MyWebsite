/* =========================
  "https://ydiak.hu/aktualis-diakmunkaink/it-munka?region=budapest";
  "https://cloud.qdiak.hu/-/items/toborzas?filter[statusz][_eq]=aktiv&filter[kategoriak][munka_kategoria_id][_in]=12&fields=id,pozicio_neve,telepules_szabad,berezes_megjeleno,oraszam_megjeleno&limit=200";
*/


import { Pool } from "pg";
import https from "https";
import http from "http";
import zlib from "zlib";
import { load as cheerioLoad } from "cheerio";
import { logFetchError, withTimeout } from "./_error-logger.mjs";
import { reconcileActive } from "./_active_core.mjs";

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

const YDIAK_SITEMAP_URL = "https://ydiak.hu/sitemap.xml";

// ydiak detail-url a sitemapból: https://ydiak.hu/{kategória-slug}/{slug} — IT-re
// szűrve, az /en/ oldalakat a horgony kizárja. A listaoldal HTML-jét Livewire
// tölti (a találati card-komponensek a nyers HTML-ben ÜRES lazy placeholderek,
// wire:key-vel), ezért a régi cheerio-parse 0 jobot adott. A sitemap viszont
// app-generált, friss (élő lastmod-ok) és a teljes élő készletet listázza —
// 2026-07-08-i élő ellenőrzés: 139 HU detail-url, a formátum kategória-oldalakon
// igazolva; halott új-formátumú url tiszta HTTP 404 (a napi sweep sima szabálya
// fogja; a RÉGI formátum 200-redirectjét a REDIRECT_DEAD_SOURCES fedi továbbra is).
const YDIAK_IT_DETAIL_RE = /^https:\/\/ydiak\.hu\/it-munka\/[^/?#]+$/;

// kategória 12 = IT; 21 (nincs publikus UI-címke, tartalom alapján software-dev)
// hozzáadva 2026-07-29 (coverage audit: 2 valódi junior dev poszt — JS Back-End
// fejlesztő, React/React Native fejlesztő — ezen a kategórián ült, sosem lett lekérve).
const QDIAK_API_URL =
  "https://cloud.qdiak.hu/-/items/toborzas?filter[statusz][_eq]=aktiv&filter[kategoriak][munka_kategoria_id][_in]=12,21&fields=id,pozicio_neve,telepules_szabad,berezes_megjeleno,oraszam_megjeleno&limit=200";

/* ── shared helpers ─────────────────────────────────────────── */

function normalizeWhitespace(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeUrl(raw) {
  try {
    const url = new URL(raw);
    url.hash = "";
    ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid", "_gl"].forEach((key) =>
      url.searchParams.delete(key)
    );
    return url.toString().replace(/\?$/, "");
  } catch {
    return raw;
  }
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
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          Accept: "text/html,application/json,*/*;q=0.8",
          "Accept-Language": "hu-HU,hu;q=0.9,en;q=0.8",
          "Accept-Encoding": "gzip,deflate,br",
        },
        timeout: 25000,
      },
      (res) => {
        const code = res.statusCode || 0;

        if ([301, 302, 303, 307, 308].includes(code)) {
          const location = res.headers.location;
          if (!location) return reject(new Error(`HTTP ${code} (no Location) for ${url}`));
          if (redirectLeft <= 0) return reject(new Error(`Too many redirects for ${url}`));
          const nextUrl = new URL(location, url).toString();
          res.resume();
          return resolve(fetchText(nextUrl, redirectLeft - 1));
        }

        const encoding = String(res.headers["content-encoding"] || "").toLowerCase();
        let stream = res;

        if (encoding.includes("gzip")) stream = res.pipe(zlib.createGunzip());
        else if (encoding.includes("deflate")) stream = res.pipe(zlib.createInflate());
        else if (encoding.includes("br")) stream = res.pipe(zlib.createBrotliDecompress());

        let body = "";
        stream.setEncoding("utf8");
        stream.on("data", (chunk) => {
          body += chunk;
        });
        stream.on("end", () => {
          if (code >= 200 && code < 300) resolve(body);
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

async function upsertJob(client, sourceKey, item) {
  await client.query(
    `INSERT INTO job_posts
      (source, title, url, experience, first_seen)
     VALUES ($1,$2,$3,$4,NOW())
     ON CONFLICT (source, url)
        DO UPDATE SET title = EXCLUDED.title
        WHERE job_posts.title IS DISTINCT FROM EXCLUDED.title;`,
    [sourceKey, item.title, item.url, item.experience ?? "-"]
  );
}

/* ── Y Diák ─────────────────────────────────────────────────── */

async function fetchYdiakItUrls() {
  try {
    const xml = await fetchText(YDIAK_SITEMAP_URL);
    const urls = [...new Set(
      [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)]
        .map((m) => normalizeUrl(m[1]))
        .filter((u) => YDIAK_IT_DETAIL_RE.test(u))
    )];
    console.log(`ydiak: ${urls.length} IT detail urls in sitemap`);
    return { urls, complete: true };
  } catch (err) {
    await logFetchError("cron_jobs_DIAK_2", { url: YDIAK_SITEMAP_URL, message: err.message, extra: { source: "ydiak" } });
    console.log(`ydiak: sitemap fetch failed: ${err.message}`);
    return { urls: [], complete: false };
  }
}

// Cím-fallback, ha a detail-oldal nem adna h1-et: slug → "Szoftverfejleszto gyakornok".
function ydiakSlugTitle(url) {
  const slug = url.split("/").filter(Boolean).pop() || "";
  const words = slug.replace(/-+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Diákmunka";
}

async function fetchYdiakTitle(url) {
  const html = await fetchText(url);
  const $ = cheerioLoad(html);
  const h1 = normalizeWhitespace($("h1").first().text());
  return h1 || ydiakSlugTitle(url);
}

/* ── Q Diák ─────────────────────────────────────────────────── */

function isBudapestQdiak(telepules) {
  const normalized = normalizeText(telepules);
  return normalized.includes("budapest") || normalized.includes("home office");
}

function extractQdiakJobs(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : [];

  return rows
    .filter((job) => isBudapestQdiak(job.telepules_szabad ?? ""))
    .map((job) => ({
      title: normalizeWhitespace(job.pozicio_neve),
      url: `https://cloud.qdiak.hu/munkak/${job.id}`,
      experience: "diákmunka",
    }))
    .filter((job) => job.title && job.url);
}

async function fetchAllQdiakJobs() {
  try {
    const text = await fetchText(QDIAK_API_URL);
    const payload = JSON.parse(text);
    const jobs = extractQdiakJobs(payload);
    console.log(`qdiak: ${jobs.length} IT Budapest jobs found (from ${payload?.data?.length ?? 0} total IT)`);
    return jobs;
  } catch (err) {
    await logFetchError("cron_jobs_DIAK_2", { url: QDIAK_API_URL, message: err.message, extra: { source: "qdiak" } });
    console.log(`qdiak: failed: ${err.message}`);
    return [];
  }
}

/* ── handler ────────────────────────────────────────────────── */

const _runJob = withTimeout("cron_jobs_DIAK_2-background", async (request) => {
  const client = await pool.connect();

  try {
    /* Y Diák — sitemap-alapú ingest (2026-07-08). Detail-oldalt (cím: <h1>)
       csak ÚJ url-nél fetchelünk — meglévő sort az upsert úgysem írna felül. */
    const ydiak = await fetchYdiakItUrls();
    if (ydiak.urls.length > 0) {
      const { rows: knownRows } = await client.query(
        `SELECT url FROM job_posts WHERE source = 'ydiak' AND url = ANY($1::text[])`,
        [ydiak.urls]
      );
      const known = new Set(knownRows.map((r) => r.url));
      for (const url of ydiak.urls) {
        if (known.has(url)) continue;
        try {
          const title = await fetchYdiakTitle(url);
          await upsertJob(client, "ydiak", { title, url, experience: "diákmunka" });
          console.log(`ydiak: NEW "${title}" → ${url}`);
        } catch (err) {
          // Detail-hiba: az ingest kimarad (a következő óránkénti run újrapróbálja),
          // de az url a foundUrls-ben marad — a sitemap-jelenlét a létezés bizonyítéka.
          await logFetchError("cron_jobs_DIAK_2", { url, message: err.message, extra: { source: "ydiak" } });
        }
      }
    }
    const rcY = await reconcileActive(client, "ydiak", ydiak.urls, { complete: ydiak.complete });
    console.log(`[ydiak] active reconcile — complete=${ydiak.complete}, ${JSON.stringify(rcY)}`);

    /* Q Diák */
    const qdiakJobs = await fetchAllQdiakJobs();
    for (const job of qdiakJobs) {
      await upsertJob(client, "qdiak", job);
    }
    console.log(`qdiak: ${qdiakJobs.length} jobs processed`);
    // The API returns the full active IT (category 12) set — exactly the subset we
    // store — under stable numeric-id URLs, so the bucket is complete. On a fetch
    // error fetchAllQdiakJobs returns [], which reconcileActive treats as an empty
    // crawl and skips deactivation. So this is safe.
    const rcQ = await reconcileActive(client, "qdiak", qdiakJobs.map((j) => j.url), { complete: true });
    console.log(`[qdiak] active reconcile — ${JSON.stringify(rcQ)}`);

    return new Response("OK");
  } finally {
    client.release();
  }
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

