// netlify/functions/cron_jobs.js

globalThis.File ??= class File {};
globalThis.Blob ??= class Blob {};
globalThis.FormData ??= class FormData {};

const https = require("https");
const http = require("http");
const zlib = require("zlib");
const cheerio = require("cheerio");
const { Pool } = require("pg");

// =====================
// DB
// =====================
const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

// =====================
// Helpers
// =====================
function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify(body),
  };
}

function stripAccents(s) {
  return String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
function normalizeText(s) {
  return stripAccents(String(s ?? "")).replace(/\s+/g, " ").trim().toLowerCase();
}
function normalizeWhitespace(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

function normalizeUrl(raw) {
  try {
    const u = new URL(raw);
    u.hash = "";
    ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid"].forEach((p) =>
      u.searchParams.delete(p)
    );
    return u.toString().replace(/\?$/, "");
  } catch {
    return raw;
  }
}

function absolutize(href, base) {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

function dedupeByUrl(items) {
  const seen = new Set();
  return items.filter((x) => {
    if (!x.url) return false;
    const u = normalizeUrl(x.url);
    if (seen.has(u)) return false;
    seen.add(u);
    x.url = u;
    return true;
  });
}

// =====================
// Sources
// =====================
const SOURCES = [
  {
    key: "melodiak",
    label: "Melódiák – gyakornoki",
    url: "https://www.melodiak.hu/diakmunkak/?l=gyakornoki-szakmai-munkak&ca=informatikai-mernoki-muszaki",
  },
  { key: "minddiak", label: "Minddiák", url: "https://minddiak.hu/position?page=2" },
  { key: "muisz", label: "Muisz – gyakornoki kategória", url: "https://muisz.hu/hu/diakmunkaink?categories=3&locations=10" },
  {
    key: "cvcentrum-gyakornok-it",
    label: "CV Centrum – gyakornok IT",
    url: "https://cvcentrum.hu/allasok/?s=gyakornok&category%5B%5D=it&category%5B%5D=it-programozas&category%5B%5D=it-uzemeltetes&type=&location%5B%5D=budapest&_noo_job_field_year_experience=&post_type=noo_job",
  },
  {
    key: "cvcentrum-intern-it",
    label: "CV Centrum – intern IT",
    url: "https://cvcentrum.hu/?s=intern&category%5B%5D=information-technology&category%5B%5D=it&category%5B%5D=it-programozas&category%5B%5D=it-uzemeltetes&category%5B%5D=networking&type=&_noo_job_field_year_experience=&post_type=noo_job",
  },
  { key: "zyntern", label: "Zyntern – IT/fejlesztés", url: "https://zyntern.com/jobs?fields=16" },
  { key: "profession-intern", label: "Profession – Intern", url: "https://www.profession.hu/allasok/it-programozas-fejlesztes/budapest/1,10,23,intern" },
  { key: "profession-gyakornok", label: "Profession – Gyakornok", url: "https://www.profession.hu/allasok/it-uzemeltetes-telekommunikacio/budapest/1,25,23,gyakornok" },
  { key: "furgediak", label: "Fürge Diák – gyakornok", url: "https://gyakornok.furgediak.hu/allasok?statikusmunkakor=7" },
  { key: "schonherz", label: "Schönherz – Budapest fejlesztő/tesztelő", url: "https://schonherz.hu/diakmunkak/budapest/fejleszto---tesztelo" },
  { key: "pannondiak", label: "Pannondiak", url: "https://pannondiak.hu/jobs/?category%5B%5D=250&category%5B%5D=1845&category%5B%5D=1848&regio%5B%5D=267#job_list" },
  { key: "prodiak", label: "Prodiák – IT állások", url: "https://www.prodiak.hu/adverts/it-5980e4975de0fe1b308b460a/budapest/kulfold" },
  { key: "qdiak", label: "Qdiák", url: "https://cloud.qdiak.hu/munkak" },
  { key: "tudasdiak", label: "Tudasdiak", url: "https://tudatosdiak.anyway.hu/hu/jobs?searchIndustry%5B%5D=7&searchMinHourlyWage=1000" },
  { key: "nix-junior", label: "NIX – junior", url: "https://nixstech.com/hu/allasok/?level=junior-hu" },
  { key: "nix-trainee", label: "NIX – trainee", url: "https://nixstech.com/hu/allasok/?level=trainee-hu" },
  { key: "otp", label: "OTP", url: "https://karrier.otpbank.hu/go/Minden-allasajanlat/1167001/?q=&q2=&alertId=&locationsearch=&title=GYAKORNOK&date=&location=&shifttype=" },
  { key: "mol", label: "MOL", url: "https://molgroup.taleo.net/careersection/external/jobsearch.ftl?lang=hu" },
  { key: "taboola", label: "TABOOLA", url: "https://www.taboola.com/careers/jobs#team=&location=31734" },
  { key: "mediso", label: "MEDISO", url: "https://mediso.com/global/hu/career?search=&location=&category=9" },
  {
    key: "continental",
    label: "CONTINENTAL",
    url: "https://jobs.continental.com/hu/#/?fieldOfWork_stringS=3a2330f4-2793-4895-b7c7-aee9c965ae22,b99ff13f-96c8-4a72-b427-dec7effd7338&location=%7B%22title%22:%22Magyarorsz%C3%A1g%22,%22type%22:%22country%22,%22countryCode%22:%22hu%22%7D&searchTerm=intern",
  },
  { key: "kh", label: "K+H", url: "https://karrier.kh.hu/allasok?q=c3BlY2lhbGl0aWVzJTVCJTVEJTNESVQlMjAlQzMlQTlzJTIwaW5ub3YlQzMlQTFjaSVDMyVCMyUyNmNpdGllcyU1QiU1RCUzREJ1ZGFwZXN0JTI2#!" },
  { key: "piller", label: "PILLER", url: "https://piller.karrierportal.hu/allasok?q=Y2l0aWVzJTVCJTVEJTNEQnVkYXBlc3QlMjYuuzzuuzz#!" },
];

exports.SOURCES = SOURCES;

// =====================
// Matching
// =====================
const KEYWORDS = [
  "gyakornok",
  "intern",
  "internship",
  "trainee",
  "junior",
  "it",
  "developer",
  "fejlesztő",
  "fejleszto",
  "data",
  "analyst",
  "support",
  "operations",
  "qa",
  "tester",
  "sysadmin",
  "network",
];

function matchesKeywords(title, desc) {
  const n = normalizeText(`${title ?? ""} ${desc ?? ""}`);
  return KEYWORDS.some((k) => n.includes(normalizeText(k)));
}

function keywordHit(title, desc) {
  const n = normalizeText(`${title ?? ""} ${desc ?? ""}`);
  return KEYWORDS.filter((k) => n.includes(normalizeText(k)));
}

// =====================
// Melódiák extraction (SSR HTML)
// =====================
function extractMelodiakCards(html) {
  const $ = cheerio.load(html);
  const items = [];

  $(".job-list-item").each((_, el) => {
    const $el = $(el);

    const title =
      normalizeWhitespace($el.find(".job-title").first().text()) ||
      normalizeWhitespace($el.find("h1,h2,h3,h4,h5,h6").first().text());

    if (!title || title.length < 4) return;

    const cls = $el.attr("class") || "";
    const tokens = cls.split(/\s+/).filter(Boolean);

    const rawSlug =
      tokens.find((t) => t.startsWith("job-list-component-")) ||
      tokens.find((t) => /^[a-z0-9]+(?:-[a-z0-9]+){3,}$/i.test(t)) ||
      null;

    if (!rawSlug) return;

    const slug = rawSlug.replace(/^job-list-component-/, "");
    const url = `https://www.melodiak.hu/diakmunkak/${slug}/`;

    items.push({
      title: title.slice(0, 300),
      url,
      description: null,
    });
  });

  return dedupeByUrl(items);
}

// =====================
// Fetch (supports gzip/deflate/br + redirect)
// =====================
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
        timeout: 12000,
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

// =====================
// DB upsert
// =====================
async function upsertJob(client, source, item) {
  await client.query(
    `
    INSERT INTO job_posts
      (source, title, url, description, first_seen)
    VALUES
      ($1, $2, $3, $4, NOW())
    ON CONFLICT (source, url)
    DO UPDATE SET
      title = EXCLUDED.title,
      description = COALESCE(EXCLUDED.description, job_posts.description)
    `,
    [source, item.title, item.url, item.description]
  );
}

function pickBatch(list, batchIndex = 0, batchSize = 3) {
  const start = batchIndex * batchSize;
  return list.slice(start, start + batchSize);
}

// =====================
// Bundle debug helpers (for Melódiák API discovery)
// =====================
function extractScriptSrcs(html, baseUrl) {
  const $ = cheerio.load(html);
  return $("script[src]")
    .map((_, s) => absolutize($(s).attr("src"), baseUrl))
    .get()
    .filter(Boolean);
}

function findBundleApiHints(jsText) {
  const hits = new Set();

  // általános endpoint minták
  (jsText.match(/\/api\/[a-z0-9_\-\/]+/gi) || []).forEach((x) => hits.add(x));
  (jsText.match(/\/graphql\b/gi) || []).forEach((x) => hits.add(x));
  (jsText.match(/https?:\/\/[^"' ]+\/api\/[^"' ]+/gi) || []).forEach((x) => hits.add(x));

  // job/search minták (Angular appoknál gyakori)
  (jsText.match(/\/(jobs?|works?|positions?|search)[a-z0-9_\-\/]*/gi) || [])
    .slice(0, 200)
    .forEach((x) => {
      if (x.length >= 6) hits.add(x);
    });

  return [...hits].slice(0, 80);
}

function bundleContextSamples(jsText, patterns, limit = 10) {
  const out = [];
  for (const p of patterns) {
    const idx = jsText.indexOf(p);
    if (idx >= 0) {
      const start = Math.max(0, idx - 80);
      const end = Math.min(jsText.length, idx + p.length + 80);
      out.push({ hit: p, context: jsText.slice(start, end) });
      if (out.length >= limit) break;
    }
  }
  return out;
}

// =====================
// Handler
// =====================
exports.handler = async (event) => {
  const qs = event.queryStringParameters || {};
  const debug = qs.debug === "1";
  const hardDebug = qs.harddebug === "1";
  const bundleDebug = qs.bundledebug === "1";

  const batch = Math.max(parseInt(qs.batch || "0", 10) || 0, 0);
  const batchSize = Math.min(Math.max(parseInt(qs.size || "3", 10) || 3, 1), 6);

  const listToProcess = pickBatch(SOURCES, batch, batchSize);
  const client = await pool.connect();

  const stats = {
    ok: true,
    node: process.version,
    ranAt: new Date().toISOString(),
    debug,
    hardDebug,
    bundleDebug,
    batch,
    batchSize,
    totalSources: SOURCES.length,
    processedThisRun: listToProcess.length,
    portals: [],
    totalFetched: 0,
    totalCandidates: 0,
    totalMatched: 0,
    totalUpserted: 0,
  };

  try {
    if (listToProcess.length === 0) {
      return json(200, { ...stats, message: "No sources for this batch (done)." });
    }

    for (const p of listToProcess) {
      const source = p.key;

      let html;
      try {
        html = await fetchText(p.url);
        stats.totalFetched++;
      } catch (err) {
        stats.portals.push({ source, label: p.label, url: p.url, ok: false, error: err.message });
        continue;
      }

      let candidates = source === "melodiak" ? extractMelodiakCards(html) : [];
      stats.totalCandidates += candidates.length;

      const matched = candidates.filter((c) => matchesKeywords(c.title, c.description));
      stats.totalMatched += matched.length;

      let up = 0;
      const upsertErrors = [];
      for (const it of matched) {
        try {
          await upsertJob(client, source, it);
          up++;
        } catch (e) {
          upsertErrors.push({ title: it.title, url: it.url, error: e.message });
        }
      }
      stats.totalUpserted += up;

      const portalStat = {
        source,
        label: p.label,
        url: p.url,
        ok: true,
        candidates: candidates.length,
        matched: matched.length,
        upserted: up,
        ...(debug && upsertErrors.length ? { upsertErrors: upsertErrors.slice(0, 10) } : {}),
      };

      if (debug) {
        portalStat.candidatesSample = candidates.slice(0, 30).map((x) => ({
          title: x.title,
          url: x.url,
          desc: x.description,
          hits: keywordHit(x.title, x.description),
        }));
        portalStat.matchedSample = matched.slice(0, 30).map((x) => ({
          title: x.title,
          url: x.url,
          desc: x.description,
          hits: keywordHit(x.title, x.description),
        }));
      }

      if (debug && hardDebug) {
        portalStat.rejectedSample = candidates
          .filter((c) => !matchesKeywords(c.title, c.description))
          .slice(0, 30)
          .map((c) => ({
            title: c.title,
            url: c.url,
            desc: c.description,
            hits: keywordHit(c.title, c.description),
          }));
      }

      // ✅ Bundle debug: script src + grepping in first bundle
      if (debug && bundleDebug && source === "melodiak") {
        const scriptSrcs = extractScriptSrcs(html, p.url);
        portalStat.scriptSrcs = scriptSrcs.slice(0, 20);

        // próbáljuk meg az első "nagy" bundle-t (main.*.js tipikusan)
        const mainLike =
          scriptSrcs.find((s) => /main\..*\.js(\?|$)/i.test(s)) ||
          scriptSrcs.find((s) => /\.js(\?|$)/i.test(s)) ||
          null;

        portalStat.mainBundle = mainLike || null;

        if (mainLike) {
          try {
            const jsText = await fetchText(mainLike);
            const bundleApiHints = findBundleApiHints(jsText);
            portalStat.bundleApiHints = bundleApiHints;
            portalStat.bundleSample = bundleContextSamples(jsText, bundleApiHints, 12);
          } catch (e) {
            portalStat.bundleError = e.message;
          }
        }
      }

      stats.portals.push(portalStat);
    }

    return json(200, stats);
  } catch (err) {
    console.error(err);
    return json(500, { ok: false, error: err.message, node: process.version });
  } finally {
    client.release();
  }
};
