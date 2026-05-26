/* ========================= keywords=teszt
  { key: "karrierhungaria", label: "karrierhungaria", url: "https://karrierhungaria.hu/allasajanlatok/vallalatiranyitasi-rendszer-sap/budapest?em[]=1" },
*/



import { Pool } from "pg";
import https from "https";
import http from "http";
import zlib from "zlib";
import { load as cheerioLoad } from "cheerio";
import { loadFilters } from "./load_filters.mjs";
import { logFetchError, withTimeout } from "./_error-logger.mjs";
import { enrichExperience, extractBodyExperience, INTERNSHIP_KEYWORDS, isInternshipTitle } from "./_experience_core.mjs";

let _filters = [];

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

// INTERNSHIP_KEYWORDS / isInternshipTitle imported from _experience_core.mjs

function _blacklistRegex(k) {
  const escaped = normalizeText(k).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i");
}

function titleNotBlacklisted(title) {
  const t = normalizeText(title);
  return !_filters.some(word => _blacklistRegex(word).test(t));
}


/* =====================
   URL helpers
===================== */
function normalizeUrl(raw) {
  try {
    const u = new URL(raw);

    u.hash = "";
    [
      "utm_source","utm_medium","utm_campaign","utm_term",
      "utm_content","fbclid","gclid","trackingId","pageNum","position","refId"
    ].forEach(p => u.searchParams.delete(p));

    return u.toString().replace(/\?$/, "");
  } catch {
    return raw;
  }
}

/* ---------------------
   Fetch helper
--------------------- */
function fetchText(url, { headers: extraHeaders, redirectLeft = 5 } = {}) {
  return new Promise((resolve, reject) => {
    console.log(`Script started at ${new Date().toISOString()}`);
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
          ...extraHeaders,
        },
        timeout: 25000,
      },
      (res) => {
        const code = res.statusCode || 0;

        if ([301,302,303,307,308].includes(code)) {
          const loc = res.headers.location;
          if (!loc) return reject(new Error(`HTTP ${code} (no Location) for ${url}`));
          if (redirectLeft <= 0) return reject(new Error(`Too many redirects for ${url}`));
          const nextUrl = new URL(loc, url).toString();
          res.resume();
          return resolve(fetchText(nextUrl, { headers: extraHeaders, redirectLeft: redirectLeft - 1 }));
        }

        const enc = String(res.headers["content-encoding"] || "").toLowerCase();
        let stream = res;
        if (enc.includes("gzip")) stream = res.pipe(zlib.createGunzip());
        else if (enc.includes("deflate")) stream = res.pipe(zlib.createInflate());
        else if (enc.includes("br")) stream = res.pipe(zlib.createBrotliDecompress());

        let data = "";
        stream.setEncoding("utf8");
        stream.on("data", (chunk) => data += chunk);
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
   Karrierhungaria Inertia API
--------------------- */
const KARRIERHUNGARIA_BASE = "https://karrierhungaria.hu";

async function getInertiaVersion() {
  const html = await fetchText(`${KARRIERHUNGARIA_BASE}/allasajanlatok`);
  const match = html.match(/data-page="([^"]*)"/);
  if (!match) throw new Error("Could not find Inertia data-page");
  const decoded = match[1].replace(/&quot;/g, '"');
  const pageData = JSON.parse(decoded);
  return pageData.version;
}

async function fetchKarrierPage(url, inertiaVersion) {
  const json = await fetchText(url, {
    headers: {
      "X-Inertia": "true",
      "X-Inertia-Version": inertiaVersion,
      "X-Requested-With": "XMLHttpRequest",
    },
  });
  return JSON.parse(json);
}

async function fetchKarrierJobs(categoryUrl, inertiaVersion) {
  let allJobs = [];
  let nextUrl = categoryUrl;
  let safetyPagesLeft = 20;
  while (nextUrl && safetyPagesLeft-- > 0) {
    const data = await fetchKarrierPage(nextUrl, inertiaVersion);
    const positions = data.props?.positions;
    const jobs = (positions?.data ?? []).map(p => ({
      title: p.title,
      url: `${KARRIERHUNGARIA_BASE}/allasajanlat/${p.href}`,
      description: p.content_company || null,
    }));
    allJobs.push(...jobs);
    nextUrl = positions?.next_page_url ?? null;
  }
  return allJobs;
}


function getDedupeKey(rawUrl) {
  return normalizeUrl(rawUrl);
}


/* ---------------------
   DB upsert
--------------------- */
async function upsertJob(client, source, item) {
  const canonicalUrl = item.url;
  const experience = isInternshipTitle(item.title) ? "diákmunka" : "-";

  await client.query(
    `INSERT INTO job_posts
      (source, title, url, canonical_url, experience, company, first_seen)
     VALUES ($1,$2,$3,$4,$5,$6,NOW())
     ON CONFLICT (source, url)
        DO NOTHING;
        `,
    [source, item.title, item.url, canonicalUrl, experience, item.company ?? null]
  );
}

function levelNotBlacklisted(title, desc) {
  const t = normalizeText(title ?? "");
  return !_filters.some((w) => _blacklistRegex(w).test(t));
}

const _runJob = withTimeout("cron_jobs_A_K-background", async (request) => {
  _filters = await loadFilters();

const SOURCES = [
  "https://karrierhungaria.hu/allasajanlatok/it-programozas-fejlesztes",
  "https://karrierhungaria.hu/allasajanlatok/it-uzemeltetes-telekommunikacio",
  "https://karrierhungaria.hu/allasajanlatok/tesztelo-tesztmernok",
  "https://karrierhungaria.hu/allasajanlatok/projektmenedzsment2",
  "https://karrierhungaria.hu/allasajanlatok/rendszerintegrator",
  "https://karrierhungaria.hu/allasajanlatok/rendszeruzemelteto",
  "https://karrierhungaria.hu/allasajanlatok/projektmenedzsment5",
  "https://karrierhungaria.hu/allasajanlatok/halozati-es-rendszermernok",
  "https://karrierhungaria.hu/allasajanlatok/adatbazisszakerto",
  "https://karrierhungaria.hu/allasajanlatok/kontrolling",
  "https://karrierhungaria.hu/allasajanlatok/programozo-fejleszto",
  "https://karrierhungaria.hu/allasajanlatok/vallalatiranyitasi-rendszer-sap",
];

  let inertiaVersion;
  try {
    inertiaVersion = await getInertiaVersion();
    console.log("Inertia version:", inertiaVersion);
  } catch (err) {
    await logFetchError("cron_jobs_A_K", { url: KARRIERHUNGARIA_BASE, message: err.message });
    console.error("Failed to get Inertia version:", err.message);
    return new Response("FAIL");
  }

  const client = await pool.connect();
  const seen = new Set();

  try {
    /* --- Karrierhungaria (Inertia API) --- */
    for (const url of SOURCES) {
      let jobs;
      try {
        jobs = await fetchKarrierJobs(url, inertiaVersion);
      } catch (err) {
        await logFetchError("cron_jobs_A_K", { url, message: err.message });
        console.error("fetch failed:", url, err.message);
        continue;
      }

      let items = jobs.filter(it => {
        const key = getDedupeKey(it.url);
        if (seen.has(key)) return false;
        seen.add(key);
        if (!levelNotBlacklisted(it.title, it.description)) return false;
        if (!titleNotBlacklisted(it.title)) return false;
        return true;
      });

      for (const it of items) {
        try {
          await upsertJob(client, "karrierhungaria", it);
        } catch (err) {
          console.error(err);
        }
      }

      console.log(`karrierhungaria (${url.split("/")[4]}): ${items.length} items processed.`);
    }

  } finally {
    console.log(`Script finished at ${new Date().toISOString()}`);
    client.release();
  }

  // Enrich experience for newly inserted karrierhungaria rows
  try {
    await enrichExperience({
      sourceFilter: "source = 'karrierhungaria'",
      extract: extractBodyExperience,
      label: "karrierhungaria",
      jobName: "cron_jobs_A_K-background",
    });
  } catch (err) {
    console.error("[cron_jobs_A_K-background] experience enrichment failed:", err.message);
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

