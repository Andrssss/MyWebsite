export const config = {
  schedule: "16 4-23 * * *",
};

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

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

const YDIAK_URL =
  "https://ydiak.hu/aktualis-diakmunkaink/it-munka?region=budapest";

const QDIAK_API_URL =
  "https://cloud.qdiak.hu/-/items/toborzas?filter[statusz][_eq]=aktiv&filter[kategoriak][munka_kategoria_id][_in]=12&fields=id,pozicio_neve,telepules_szabad,berezes_megjeleno,oraszam_megjeleno&limit=200";

const PRODIAK_API_URL = "https://www.prodiak.hu/api/adverts?page=1";
const PRODIAK_POST_BODY = JSON.stringify({
  categories: "5980e5825de0fe6b408b45a2",
  locations: "54f4eeaf3cc4952d2c8b459f,5b17bddf5de0fe30018b4705",
  territorials: "",
});

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
        timeout: 50000,
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
  const canonicalUrl = normalizeUrl(item.url);

  await client.query(
    `INSERT INTO job_posts
      (source, title, url, canonical_url, experience, first_seen)
     VALUES ($1,$2,$3,$4,$5,NOW())
     ON CONFLICT (source, url)
     DO UPDATE SET
       title = EXCLUDED.title,
       canonical_url = EXCLUDED.canonical_url,
       experience = COALESCE(EXCLUDED.experience, job_posts.experience);`,
    [sourceKey, item.title, item.url, canonicalUrl, item.experience ?? "-"]
  );
}

/* ── Y Diák ─────────────────────────────────────────────────── */

function extractYdiakJobs(html) {
  const $ = cheerioLoad(html);
  const jobs = [];
  const seen = new Set();

  $("#search-results article").each((_i, el) => {
    const $art = $(el);

    const title = normalizeWhitespace($art.find("h4").first().text());
    if (!title) return;

    const $link = $art.find('a[href*="/it-munka/"]').first();
    let href = $link.attr("href");
    if (!href) return;

    const url = normalizeUrl(
      href.startsWith("http") ? href : `https://ydiak.hu${href}`
    );

    if (seen.has(url)) return;
    seen.add(url);

    jobs.push({
      title,
      url,
      experience: "diákmunka",
    });
  });

  return jobs;
}

async function fetchAllYdiakJobs() {
  try {
    const html = await fetchText(YDIAK_URL);
    const jobs = extractYdiakJobs(html);
    console.log(`ydiak: ${jobs.length} IT jobs found`);
    return jobs;
  } catch (err) {
    await logFetchError("cron_jobs_19", { url: YDIAK_URL, message: err.message, extra: { source: "ydiak" } });
    console.log(`ydiak: failed: ${err.message}`);
    return [];
  }
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
    await logFetchError("cron_jobs_19", { url: QDIAK_API_URL, message: err.message, extra: { source: "qdiak" } });
    console.log(`qdiak: failed: ${err.message}`);
    return [];
  }
}

/* ── Prodiák ────────────────────────────────────────────────── */

function extractProdiakJobs(payload) {
  const rows = Array.isArray(payload?.adverts?.data) ? payload.adverts.data : [];
  return rows.map((d) => ({
    title: normalizeWhitespace(d.name),
    url: `https://www.prodiak.hu/allas/${d.slug}/${d.index_id}`,
    experience: "diákmunka",
  })).filter((job) => job.title && job.url);
}

function fetchProdiakApi(pageUrl) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(pageUrl);
    const req = https.request(
      parsedUrl,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "X-Requested-With": "XMLHttpRequest",
          "Content-Length": Buffer.byteLength(PRODIAK_POST_BODY),
        },
        timeout: 50000,
      },
      (res) => {
        const encoding = String(res.headers["content-encoding"] || "").toLowerCase();
        let stream = res;
        if (encoding.includes("gzip")) stream = res.pipe(zlib.createGunzip());
        else if (encoding.includes("deflate")) stream = res.pipe(zlib.createInflate());
        else if (encoding.includes("br")) stream = res.pipe(zlib.createBrotliDecompress());

        let body = "";
        stream.setEncoding("utf8");
        stream.on("data", (chunk) => { body += chunk; });
        stream.on("end", () => resolve(body));
        stream.on("error", reject);
      }
    );
    req.on("timeout", () => req.destroy(new Error(`Timeout for ${pageUrl}`)));
    req.on("error", reject);
    req.write(PRODIAK_POST_BODY);
    req.end();
  });
}

async function fetchAllProdiakJobs() {
  const allJobs = [];
  let page = 1;
  try {
    while (true) {
      const url = `${PRODIAK_API_URL.replace(/page=\d+/, `page=${page}`)}`;
      const text = await fetchProdiakApi(url);
      const payload = JSON.parse(text);
      const jobs = extractProdiakJobs(payload);
      allJobs.push(...jobs);
      const lastPage = payload?.adverts?.last_page ?? 1;
      if (page >= lastPage) break;
      page++;
    }
    console.log(`prodiak: ${allJobs.length} IT Budapest jobs found (${page} pages)`);
    return allJobs;
  } catch (err) {
    await logFetchError("cron_jobs_19", { url: PRODIAK_API_URL, message: err.message, extra: { source: "prodiak", page } });
    console.log(`prodiak: failed on page ${page}: ${err.message}`);
    return allJobs;
  }
}

/* ── handler ────────────────────────────────────────────────── */

export default withTimeout("cron_jobs_19", async () => {
  const client = await pool.connect();

  try {
    /* Y Diák */
    const ydiakJobs = await fetchAllYdiakJobs();
    for (const job of ydiakJobs) {
      await upsertJob(client, "ydiak", job);
    }
    console.log(`ydiak: ${ydiakJobs.length} jobs processed`);

    /* Q Diák */
    const qdiakJobs = await fetchAllQdiakJobs();
    for (const job of qdiakJobs) {
      await upsertJob(client, "qdiak", job);
    }
    console.log(`qdiak: ${qdiakJobs.length} jobs processed`);

    /* Prodiák */
    const prodiakJobs = await fetchAllProdiakJobs();
    for (const job of prodiakJobs) {
      await upsertJob(client, "prodiak", job);
    }
    console.log(`prodiak: ${prodiakJobs.length} jobs processed`);

    return new Response("OK");
  } finally {
    client.release();
  }
});
