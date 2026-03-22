
import { Pool } from "pg";
import https from "https";
import http from "http";
import zlib from "zlib";
import { load as cheerioLoad } from "cheerio";

// =====================
// DB
// =====================
const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

async function runAllBatches() {
  const size = 4;
  const totalBatches = Math.ceil(SOURCES.length / size);

  console.log("[runAllBatches]", totalBatches, "batches");

  for (let batch = 0; batch < totalBatches; batch++) {
    await runBatch({ batch, size, write: true, debug: false, bundleDebug: false });
    await sleep(50);
  }
}

// =====================
// HELPERS
// =====================
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function stripAccents(s) {
  return String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function normalizeText(s) {
  return stripAccents(s).replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizeWhitespace(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

function normalizeUrl(raw) {
  try {
    const u = new URL(raw);
    u.hash = "";
    [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "fbclid",
      "gclid",
      "sessionId",
      "hash",
      "keyword"
    ].forEach((p) => u.searchParams.delete(p));
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

function mergeCandidates(...lists) {
  const merged = [];
  for (const arr of lists) {
    if (Array.isArray(arr)) merged.push(...arr);
  }
  return dedupeByUrl(merged);
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

const SOURCES = [
  { key: "bluebird", label: "bluebird", url: "https://bluebird.hu/it-allasok-es-it-projektek/" }
];

function hasWord(n, w) {
  const re = new RegExp(`\\b${w.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\b`, "i");
  return re.test(n);
}

const SENIOR_KEYWORDS = [
  "senior",
  "szenior",
  "medior",
  "lead",
  "principal",
  "staff",
  "architect",
  "expert",
  "vezető fejlesztő",
  "tech lead"
];

function matchesKeywords(title, desc) {
  const n = normalizeText(`${title ?? ""} ${desc ?? ""}`);
  const strongHit = [
    "gyakornok", "intern", "internship", "trainee", "junior", "developer", "fejlesztő", "fejleszto", "szoftverfejleszto", "engineer", "software", "data", "analyst", "scientist", "automation", "java", "python", "javascript", "php", "c++", "nodejs", "database", "test", "teszt", "testing", "teszteles", "tesztelés", "web", "weboldal", "net", "node", "typescript", "sql", "frontend", "backend", "fullstack", "full-stack", "webfejleszto", "webfejlesztő", "react", "angular", "devops", "cloud", "infrastructure", "platform", "platforms", "service", "services", "helpdesk", "security", "biztonsag", "biztonsagi", "biztonsági", "biztonsagtechnikai", "biztonságtechnikai", "kiberbiztonsag", "kiberbiztonsági", "kiberbiztonság", "rendszermernok", "rendszermérnök", "uzemeltetes", "uzemeltetesi", "üzemeltetés", "üzemeltetési", "penzugy", "pénzügy", "penzugyi", "pénzügyi", "digitalis", "digitális", "power", "application", "system", "systems", "engineering", "development", "program", "programozo", "integration", "technical", "quality", "servicenow", "linux", "android", "databricks", "abap", "sap", "informatikai", "informatika", "rendszer", "rendszergazda", "rendszeruzemelteto", "rendszeruzemeltető", "uzemelteto", "üzemeltető", "szoftvertesztelo", "szoftvertesztelő", "manual", "embedded", "systemtest", "tesztrendszer", "applications", "graduate", "graduates", "tesztelo", "support", "operations", "qa", "tester", "sysadmin", "network", "jog", "jogi"
  ].some(k => n.includes(normalizeText(k)));
  const itHit = hasWord(n, "it");
  return strongHit || (itHit && /support|sysadmin|network|qa|tester|developer|data|analyst|operations|security|biztonsag|tanacsado|consultant/.test(n));
}

function isSeniorLike(title = "", desc = "") {
  const n = normalizeText(`${title} ${desc}`);
  return SENIOR_KEYWORDS.some(k => n.includes(normalizeText(k)));
}

function extractSSR(html, baseUrl) {
  const $ = cheerioLoad(html);
  const items = [];
  const CARD_SELECTORS = [
    "app-job-list-item",
    "article",
    "li",
    ".job",
    ".job-list-item",
    ".position",
    ".listing",
    ".card",
    ".item",
    ".vacancy",
    ".vacancies__item",
    "[data-href]",
    "[data-url]",
    "[onclick]",
    "[role='link']",
    "[routerlink]",
  ].join(",");
  $(CARD_SELECTORS).each((_, el) => {
    const $card = $(el);
    let href =
      $card.attr("data-href") ||
      $card.attr("data-url") ||
      $card.attr("routerlink") ||
      null;
    if (!href) {
      const oc = $card.attr("onclick") || "";
      const m = oc.match(/(?:location\.href|window\.location)\s*=\s*['"]([^'"]+)['"]/i)
        || oc.match(/['"]([^'"]+)['"]/);
      if (m && m[1]) href = m[1];
    }
    if (!href) {
      const a = $card.find("a[href]").first();
      href = a.attr("href") || null;
    }
    const url = href ? absolutize(href, baseUrl) : null;
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) return;
    if (/\.(jpg|jpeg|png|gif|svg|webp|pdf|zip|rar|7z)(\?|#|$)/i.test(url)) return;
    let title =
      normalizeWhitespace($card.find("h1,h2,h3,h4,h5,h6").first().text()) ||
      normalizeWhitespace($card.find(".title,.job-title,.position-title,.name").first().text()) ||
      normalizeWhitespace($card.find("strong").first().text()) ||
      null;
    if (!title || title.length < 4) {
      const aText = normalizeWhitespace($card.find("a[href]").first().text());
      if (aText && !isCtaTitle(aText)) title = aText;
    }
    title = normalizeWhitespace(title);
    if (!title || title.length < 4) return;
    if (isCtaTitle(title)) return;
    const desc =
      normalizeWhitespace($card.find("p").first().text()) ||
      normalizeWhitespace($card.find(".description,.job-desc,.job-description").first().text()) ||
      null;
    items.push({
      title: title.slice(0, 300),
      url,
      description: desc ? desc.slice(0, 800) : null,
    });
  });
  return dedupeByUrl(items);
}

const CTA_TITLES = new Set([
  "megnézem",
  "megnezem",
  "részletek",
  "reszletek",
  "tovább",
  "tovabb",
  "bővebben",
  "bovebben",
  "jelentkezem",
  "jelentkezés",
  "jelentkezes",
  "apply",
  "details",
  "view",
  "open",
  "more",
]);
function isCtaTitle(s) {
  const n = normalizeText(s);
  return !n || n.length < 4 || CTA_TITLES.has(n);
}

function extractCandidates(html, baseUrl) {
  const $ = cheerioLoad(html);
  const items = [];
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    const url = absolutize(href, baseUrl);
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) return;
    if (/\.(jpg|jpeg|png|gif|svg|webp|pdf|zip|rar|7z)(\?|#|$)/i.test(url)) return;
    let card = $(el).closest("app-job-list-item, article, li, .job-list-item, .job, .position, .listing, .card, .item");
    if (!card.length) card = $(el).closest("div");
    const linkText = normalizeWhitespace($(el).text());
    const headingText =
      normalizeWhitespace(card.find("h1,h2,h3,h4,h5,h6").first().text()) ||
      normalizeWhitespace($(el).parent().find("h1,h2,h3,h4,h5,h6").first().text());
    let title = linkText;
    if (headingText && (isCtaTitle(linkText) || headingText.length > linkText.length + 3)) {
      title = headingText;
    }
    title = normalizeWhitespace(title);
    if (!title || title.length < 4) return;
    const desc =
      normalizeWhitespace(card.find("p").first().text()) ||
      normalizeWhitespace(card.find(".description, .job-desc, .job-description").first().text()) ||
      null;
    items.push({
      title: title.slice(0, 300),
      url,
      description: desc ? desc.slice(0, 800) : null,
    });
  });
  return dedupeByUrl(items);
}

async function upsertJob(client, source, item) {
  const canonicalUrl = normalizeUrl(item.url);
  const experience = extractExperience(item.description);
  await client.query(
    `INSERT INTO job_posts
      (source, title, url, experience, first_seen)
     VALUES ($1,$2,$3,$4,NOW())
     ON CONFLICT (source, url)
     DO NOTHING;
    `,
    [
      source,
      item.title,
      canonicalUrl,
      experience
    ]
  );
}

function extractExperience(description) {
  if (!description) return null;
  const patterns = [
    /(\d+\s?\+\s?(?:év|years?))/gi,
    /(\d+\s?(?:[-–]\s?\d+)?\s?(?:év|éves|years?|yrs?))/gi,
    /(minimum\s?\d+\s?(?:év|years?))/gi,
    /(at least\s?\d+\s?(?:years?))/gi
  ];
  const matches = [];
  for (const regex of patterns) {
    const found = description.match(regex);
    if (found) matches.push(...found);
  }
  return matches.length ? [...new Set(matches)].join(", ") : null;
}

async function runBatch({ batch, size, write, debug = false, bundleDebug = false }) {
  const listToProcess = SOURCES.slice(batch * size, batch * size + size);
  const client = write ? await pool.connect() : null;
  const stats = {
    ok: true,
    node: process.version,
    ranAt: new Date().toISOString(),
    debug: !!debug,
    bundleDebug: !!bundleDebug,
    write: !!write,
    batch,
    size,
    processedThisRun: listToProcess.length,
    totalSources: SOURCES.length,
    portals: [],
  };
  try {
    for (const p of listToProcess) {
      const source = p.key;
      let html = null;
      try {
        html = await fetchText(p.url);
      } catch (err) {
        stats.portals.push({ source, label: p.label, url: p.url, ok: false, error: err.message });
        continue;
      }
      let merged = [];
      let generic = extractCandidates(html, p.url).filter((c) => true);
      let ssr = extractSSR(html, p.url).filter((c) => true);
      merged = mergeCandidates(generic, ssr);
      let matchedList = merged
        .filter((c) => matchesKeywords(c.title, c.description))
        .filter((c) => !isSeniorLike(c.title, c.description));
      let rejected = [];
      if (debug) {
        rejected = merged
          .filter((c) => !matchesKeywords(c.title, c.description))
          .slice(0, 30)
          .map((c) => {
            const norm = normalizeText(`${c.title ?? ""} ${c.description ?? ""}`);
            return {
              title: c.title,
              url: c.url,
            };
          });
      }
      stats.portals.push({ source, label: p.label, url: p.url, ok: true, matched: matchedList.length, rejected });
      if (write && client) {
        for (const item of matchedList) {
          await upsertJob(client, source, item);
        }
      }
    }
  } finally {
    if (client) client.release();
  }
  return stats;
}

export default async (request) => {
  const url = new URL(request.url);
  const debug = url.searchParams.get("debug") === "1";
  const bundleDebug = url.searchParams.get("bundledebug") === "1";
  const write = url.searchParams.get("write") === "1";
  if (!debug) {
    await runAllBatches();
    return new Response("Cron jobs done", { status: 200 });
  }
  const batch = Number(url.searchParams.get("batch") || 0);
  const size = Number(url.searchParams.get("size") || 4);
  const stats = await runBatch({
    batch,
    size,
    write,
    debug: true,
    bundleDebug,
  });
  return new Response(JSON.stringify(stats), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
