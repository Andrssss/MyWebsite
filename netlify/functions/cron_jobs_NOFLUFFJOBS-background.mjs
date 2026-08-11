import https from "node:https";
import http from "node:http";
import zlib from "node:zlib";
import { load as cheerioLoad } from "cheerio";
import pkg from "pg";
const { Pool } = pkg;
import { loadFilters } from "./load_filters.mjs";
import { logFetchError, withTimeout } from "./_error-logger.mjs";
import { extractBodyExperience } from "./_experience_core.mjs";

let _filters = [];

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

const NOFLUFF_SOURCES = [
  "https://nofluffjobs.com/hu/budapest?criteria=seniority%3Dtrainee,junior",
  "https://nofluffjobs.com/hu/budapest?criteria=seniority%3Dtrainee,junior&sort=newest",
  "https://nofluffjobs.com/hu/budapest/artificial-intelligence?criteria=requirement%3DJava,Python,C%23,SQL,C%2B%2B,Golang,JavaScript,React,Angular,TypeScript,HTML,Git,Vue.js,Kotlin,Android%20category%3Dsys-administrator,business-analyst,architecture,backend,data,ux,devops,erp,embedded,frontend,fullstack,game-dev,mobile,project-manager,security,support,testing,other%20seniority%3Dtrainee,junior",
];

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

function mergeCandidates(...lists) {
  const merged = [];
  for (const arr of lists) {
    if (Array.isArray(arr)) merged.push(...arr);
  }
  return dedupeByUrl(merged);
}

function _blacklistRegex(k) {
  const escaped = normalizeText(k).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i");
}

function isSeniorLike(title) {
  const n = normalizeText(title);
  return _filters.some((k) => _blacklistRegex(k).test(n));
}

function looksLikeNofluffJobUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    if (!url.startsWith("https://nofluffjobs.com/hu/job/")) return false;
    const slug = u.pathname.replace("/hu/job/", "");
    if (!slug.includes("budapest")) return false;
    return true;
  } catch {
    return false;
  }
}

const CTA_TITLES = new Set([
  "megnézem", "megnezem", "részletek", "reszletek", "tovább", "tovabb",
  "bővebben", "bovebben", "jelentkezem", "jelentkezés", "jelentkezes",
  "apply", "details", "view", "open", "more",
]);

function isCtaTitle(s) {
  const n = normalizeText(s);
  return !n || n.length < 4 || CTA_TITLES.has(n);
}

function cleanJobTitle(rawTitle) {
  if (!rawTitle) return null;
  const cutMarkers = ["ÚJ", "NEW", "FRISS"];
  let title = rawTitle;
  for (const marker of cutMarkers) {
    const idx = title.indexOf(marker);
    if (idx >= 0) {
      title = title.slice(0, idx);
      break;
    }
  }
  return title.trim().replace(/[-–:]+$/g, "").trim();
}

/* ── fetch ───────────────────────────────────────────────────── */

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
        timeout: 25000,
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

/* ── extraction ─────────────────────────────────────────────── */

function extractCandidates(html, baseUrl) {
  const $ = cheerioLoad(html);
  const items = [];

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    const url = absolutize(href, baseUrl);
    if (!url || !/^https?:\/\//i.test(url)) return;
    if (/\.(jpg|jpeg|png|gif|svg|webp|pdf|zip|rar|7z)(\?|#|$)/i.test(url)) return;

    let card = $(el).closest("app-job-list-item, article, li, .job-list-item, .job, .position, .listing, .card, .item");
    if (!card.length) card = $(el).closest("div");

    const linkText = normalizeWhitespace($(el).text());
    // Check heading INSIDE the link itself first (e.g. NoFluffJobs where <a> IS the card)
    const headingText =
      normalizeWhitespace($(el).find("h1,h2,h3,h4,h5,h6").first().text()) ||
      normalizeWhitespace(card.find("h1,h2,h3,h4,h5,h6").first().text()) ||
      normalizeWhitespace($(el).parent().find("h1,h2,h3,h4,h5,h6").first().text());

    let title = linkText;
    if (headingText && !isCtaTitle(headingText) && (isCtaTitle(linkText) || linkText.length > headingText.length + 15)) {
      title = headingText;
    }
    title = normalizeWhitespace(title);
    if (!title || title.length < 4) return;

    const company =
      normalizeWhitespace($(el).find('[class*="company"]').first().text()) ||
      normalizeWhitespace(card.find('[class*="company"]').first().text()) ||
      normalizeWhitespace($(el).find('[class*="employer"]').first().text()) ||
      normalizeWhitespace(card.find('[class*="employer"]').first().text()) ||
      null;

    items.push({ title: title.slice(0, 300), url, company: company ? company.slice(0, 200) : null });
  });

  return dedupeByUrl(items);
}

function extractSSR(html, baseUrl) {
  const $ = cheerioLoad(html);
  const items = [];
  const CARD_SELECTORS = [
    "app-job-list-item", "article", "li", ".job", ".job-list-item",
    ".position", ".listing", ".card", ".item", ".vacancy", ".vacancies__item",
    "[data-href]", "[data-url]", "[onclick]", "[role='link']", "[routerlink]",
  ].join(",");

  $(CARD_SELECTORS).each((_, el) => {
    const $card = $(el);
    let href =
      $card.attr("data-href") || $card.attr("data-url") || $card.attr("routerlink") || null;

    if (!href) {
      const oc = $card.attr("onclick") || "";
      const m =
        oc.match(/(?:location\.href|window\.location)\s*=\s*['"]([^'"]+)['"]/i) ||
        oc.match(/['"]([^'"]+)['"]/);
      if (m && m[1]) href = m[1];
    }
    if (!href) href = $card.find("a[href]").first().attr("href") || null;

    const url = href ? absolutize(href, baseUrl) : null;
    if (!url || !/^https?:\/\//i.test(url)) return;
    if (/\.(jpg|jpeg|png|gif|svg|webp|pdf|zip|rar|7z)(\?|#|$)/i.test(url)) return;

    let title =
      normalizeWhitespace($card.find("h1,h2,h3,h4,h5,h6").first().text()) ||
      normalizeWhitespace($card.find(".title,.job-title,.position-title,.name").first().text()) ||
      normalizeWhitespace($card.find("strong").first().text()) || null;

    if (!title || title.length < 4) {
      const aText = normalizeWhitespace($card.find("a[href]").first().text());
      if (aText && !isCtaTitle(aText)) title = aText;
    }
    title = normalizeWhitespace(title);
    if (!title || title.length < 4 || isCtaTitle(title)) return;

    const company =
      normalizeWhitespace($card.find('[class*="company"]').first().text()) ||
      normalizeWhitespace($card.find('[class*="employer"]').first().text()) ||
      null;

    items.push({ title: title.slice(0, 300), url, company: company ? company.slice(0, 200) : null });
  });

  return dedupeByUrl(items);
}

/* ── experience fetch ───────────────────────────────────────── */

async function fetchNofluffExperience(url) {
  try {
    const html = await fetchText(url);
    const normalizedHtml = html.replace(/\u2013/g, "-").replace(/\u2014/g, "-");
    return extractBodyExperience(normalizedHtml) || null;
  } catch (err) {
    await logFetchError("cron_jobs_NOFLUFFJOBS", { url, message: `nofluff experience: ${err.message}` });
    return null;
  }
}

/* ── DB ──────────────────────────────────────────────────────── */

async function upsertJob(client, item) {
  const canonicalUrl = normalizeUrl(item.url);
  await client.query(
    `INSERT INTO job_posts
      (source, title, url, canonical_url, experience, company, first_seen)
     VALUES ($1,$2,$3,$4,$5,$6,NOW())
     ON CONFLICT (source, url)
        DO NOTHING;`,
    ["nofluffjobs", item.title, item.url, canonicalUrl, item.experience ?? "-", item.company || null]
  );
}

/* ── main scrape ─────────────────────────────────────────────── */

async function scrapeNofluffjobs(client) {
  const seen = new Set();
  let totalUpserted = 0;

  for (const sourceUrl of NOFLUFF_SOURCES) {
    console.log(`[nofluffjobs] Fetching: ${sourceUrl}`);
    let html;
    try {
      html = await fetchText(sourceUrl);
    } catch (err) {
      await logFetchError("cron_jobs_NOFLUFFJOBS", { url: sourceUrl, message: err.message });
      console.error(`[nofluffjobs] Fetch failed: ${err.message}`);
      continue;
    }

    const generic = extractCandidates(html, sourceUrl).filter((c) => looksLikeNofluffJobUrl(c.url));
    const ssr = extractSSR(html, sourceUrl).filter((c) => looksLikeNofluffJobUrl(c.url));
    let merged = mergeCandidates(generic, ssr);
    console.log(`[nofluffjobs]   generic=${generic.length} ssr=${ssr.length} merged=${merged.length}`);

    // dedupe across source URLs
    merged = merged.filter((c) => {
      const u = normalizeUrl(c.url);
      if (seen.has(u)) return false;
      seen.add(u);
      return true;
    });

    // clean & senior filter
    merged = merged
      .map((c) => ({ ...c, title: cleanJobTitle(c.title) ?? c.title }))
      .filter((c) => {
        if (isSeniorLike(c.title)) {
          console.log(`[nofluffjobs]   [seniorFilter] KISZŰRVE: "${c.title}"`);
          return false;
        }
        return true;
      });

    console.log(`[nofluffjobs]   after filters: ${merged.length}`);

    for (const item of merged) {
      const exp = await fetchNofluffExperience(item.url);
      if (exp) item.experience = exp;
      await sleep(400);
      console.log(`[nofluffjobs]   upsert [${item.experience ?? "-"}] "${item.title}"`);
      await upsertJob(client, item);
      totalUpserted++;
    }

    await sleep(1000);
  }

  return totalUpserted;
}

/* ── handler ─────────────────────────────────────────────────── */

const _runJob = withTimeout("cron_jobs_NOFLUFFJOBS-background", async (request) => {
  _filters = await loadFilters();
  const client = await pool.connect();

  try {
    const total = await scrapeNofluffjobs(client);
    console.log(`[nofluffjobs] done — ${total} jobs upserted`);
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
