export const config = {
  schedule: "7 4-23 * * *",
};

/* ========================= keywords=teszt
      { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?distance=10&f_E=2&f_TPR=r86400&keywords=teszt&location=Budapest&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
*/

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

const INTERNSHIP_KEYWORDS = [
  "gyakornok", "intern", "internship", "trainee",
  "pályakezdő", "palyakezdo", "diákmunka", "diakmunka",
];
function isInternshipTitle(title) {
  const t = normalizeText(title);
  return INTERNSHIP_KEYWORDS.some(k => t.includes(k));
}


function titleNotBlacklisted(title) {
  const TITLE_BLACKLIST = [
    "marketing","sales","hr","finance","pénzügy","könyvelő",
    "accountant","manager","vezető","director","adminisztráció",
    "asszisztens","ügyfélszolgálat","customer service","call center",
    "értékesítő","bizto sítás","tanácsadó","biztosítás",
    "Adótanácsadó","Auditor","Accountant","Accounts","Tanácsadó",
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
  const t = normalizeText(title);
  return !TITLE_BLACKLIST.some(word => t.includes(normalizeText(word)));
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

function matchesKeywords(title, desc) {
  const KEYWORDS_STRONG = [
  "gyakornok",
  "intern",
  "internship",
  "trainee",
  "junior",
  "developer",
  "fejlesztő",
  "fejleszto",
  "szoftverfejleszto",
  "engineer",
  "software",
  "data",
  "analyst",
  "scientist",
  "automation",
  "java",
  "python",
  "javascript",
  "php",
  "c++",
  "nodejs",
  "database",
  "test",
  "teszt",
  "testing",
  "teszteles",
  "tesztelés",
  "web",
  "weboldal",
  "net",
  "node",
  "typescript",
  "sql",
  "frontend",
  "backend",
  "fullstack",
  "full-stack",
  "webfejleszto",
  "webfejlesztő",
  "react",
  "angular",
  "devops",
  "cloud",
  "infrastructure",
  "platform",
  "platforms",
  "service",
  "services",
  "helpdesk",
  "security",
  "biztonsag",
  "biztonsagi",
  "biztonsági",
  "biztonsagtechnikai",
  "biztonságtechnikai",
  "kiberbiztonsag",
  "kiberbiztonsági",
  "kiberbiztonság",
  "rendszermernok",
  "rendszermérnök",
  "uzemeltetes",
  "uzemeltetesi",
  "üzemeltetés",
  "üzemeltetési",
  "penzugy",
  "pénzügy",
  "penzugyi",
  "pénzügyi",
  "digitalis",
  "digitális",
  "power",
  "application",
  "system",
  "systems",
  "engineering",
  "development",
  "program",
  "programozo",
  "integration",
  "technical",
  "quality",
  "servicenow",
  "linux",
  "android",
  "databricks",
  "abap",
  "sap",
  "informatikai",
  "informatika",
  "rendszer",
  "rendszergazda",
  "rendszeruzemelteto",
  "rendszeruzemeltető",
  "uzemelteto",
  "üzemeltető",
  "szoftvertesztelo",
  "szoftvertesztelő",
  "manual",
  "embedded",
  "systemtest",
  "tesztrendszer",
  "applications",
  "graduate",
  "graduates",
  "tesztelo",
  "support",
  "operations",
  "qa",
  "tester",
  "sysadmin",
  "network",
  "jog",
  "jogi",

];
  const n = normalizeText(`${title ?? ""} ${desc ?? ""}`);
  const strongHit = KEYWORDS_STRONG.some(k => n.includes(normalizeText(k)));
  const itHit = /\bit\b/i.test(n);
  const aiHit = /\bai\b/i.test(n);
  return strongHit || (
    (itHit || aiHit) &&
    /support|sysadmin|network|qa|tester|developer|data|analyst|operations|security|biztonsag|tanacsado|consultant|engineer|fejleszto|fejlesztő/.test(n)
  );
}

/* =====================
   URL helpers
===================== */
function normalizeUrl(raw) {
  try {
    const u = new URL(raw);

    /*
    if (u.hostname.includes("linkedin.com") && u.pathname.startsWith("/jobs/view/")) {
      u.search = "";
      u.hash = "";
      return u.toString();
    }
      */

    if (u.hostname.includes("linkedin.com") && u.pathname.startsWith("/jobs/view/")) {
      return `https://${u.hostname}${u.pathname}`; // teljesen eldobjuk a query stringet
    }

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
function fetchText(url, redirectLeft = 5) {
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
        },
        timeout: 50000,
      },
      (res) => {
        const code = res.statusCode || 0;

        if ([301,302,303,307,308].includes(code)) {
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
   HTML extraction
--------------------- */

/* ---------------------
   LinkedIn extraction
--------------------- */
function extractLinkedInJobs(html) {
  const $ = cheerioLoad(html);
  const jobs = [];

  $("ul.jobs-search__results-list li").each((_, el) => {
    const title = normalizeText($(el).find("h3.base-search-card__title").text());
    const company = normalizeText($(el).find("h4.base-search-card__subtitle").text());
    const location = normalizeText($(el).find("span.job-search-card__location").text());
    const url = $(el).find("a.base-card__full-link").attr("href");
    if (title && url) jobs.push({ title, url, company, location });
  });

  return dedupeByUrl(jobs);
}

function canonicalizeLinkedInJobUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.hostname.includes("linkedin.com") && u.pathname.startsWith("/jobs/view/")) {
      const lastPart = u.pathname.split("/jobs/view/")[1];
      const canonicalSlug = lastPart.replace(/-\d+$/, "");
      return `https://www.linkedin.com/jobs/view/${canonicalSlug}`;
    }
    return raw;
  } catch {
    return raw;
  }
}

function getDedupeKey(rawUrl) {
  const u = normalizeUrl(rawUrl);
  if (u.includes("linkedin.com/jobs/view/")) return canonicalizeLinkedInJobUrl(u);
  return u;
}

/* ---------------------
   DB upsert
--------------------- */
async function upsertJob(client, source, item) {
  const canonicalUrl =
    source === "LinkedIn"
      ? canonicalizeLinkedInJobUrl(item.url)
      : item.url;
  const experience = isInternshipTitle(item.title) ? "diákmunka" : "-";

  await client.query(
    `INSERT INTO job_posts
      (source, title, url, canonical_url, experience, first_seen)
     VALUES ($1,$2,$3,$4,$5,NOW())
     ON CONFLICT (source, canonical_url)
        DO NOTHING;
        `,
    [source, item.title, item.url, canonicalUrl, experience]
  );
}

function levelNotBlacklisted(title, desc) {
  const LEVEL_BLACKLIST = [
    "medior", "senior", "lead", "principal", "expert",
    "staff", "architect", "sr.", "sr ", "sen.",
    "experienced", "expertise"
  ];
  const t = normalizeText(`${title ?? ""} ${desc ?? ""}`);
  return !LEVEL_BLACKLIST.some(w => t.includes(normalizeText(w)));
}

export default async () => {
  



const SOURCES = [
    // TEST
    { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?distance=0&f_E=2&f_TPR=r86400&keywords=test&location=Budapest&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
    { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?distance=0&f_E=1&f_TPR=r86400&keywords=test&location=Budapest&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
    { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?distance=0&f_E=2&f_TPR=r604800&keywords=test&location=Budapest&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
    { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?distance=0&f_E=1&f_TPR=r604800&keywords=test&location=Budapest&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
    { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?keywords=test&location=Budapest" },
    { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?distance=0&f_E=1&keywords=test&location=Budapest&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
    { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?distance=0&f_E=2&keywords=test&location=Budapest&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
    { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?distance=10&f_E=2&f_TPR=r86400&keywords=test&location=Budapest&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
    { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?distance=10&f_E=1&f_TPR=r86400&keywords=test&location=Budapest&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
    { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?distance=10&f_E=2&f_TPR=r604800&keywords=test&location=Budapest&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
    { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?distance=10&f_E=1&f_TPR=r604800&keywords=test&location=Budapest&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
    { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?distance=10&f_E=1&keywords=test&location=Budapest&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
    { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?distance=10&f_E=2&keywords=test&location=Budapest&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
    { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?f_E=2&keywords=test&location=Budapest&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
    { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?distance=5&f_E=2&keywords=test&location=Budapest&origin=JOB_SEARCH_PAGE_JOB_FILTER" },

    // TESZT
    { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?distance=0&f_E=2&f_TPR=r86400&keywords=teszt&location=Budapest&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
    { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?distance=0&f_E=1&f_TPR=r86400&keywords=teszt&location=Budapest&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
    { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?distance=0&f_E=2&f_TPR=r604800&keywords=teszt&location=Budapest&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
    { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?distance=0&f_E=1&f_TPR=r604800&keywords=teszt&location=Budapest&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
    { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?keywords=teszt&location=Budapest" },
    { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?distance=0&f_E=1&keywords=teszt&location=Budapest&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
    { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?distance=0&f_E=2&keywords=teszt&location=Budapest&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
    { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?distance=10&f_E=2&f_TPR=r86400&keywords=teszt&location=Budapest&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
    { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?distance=10&f_E=1&f_TPR=r86400&keywords=teszt&location=Budapest&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
    { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?distance=10&f_E=2&f_TPR=r604800&keywords=teszt&location=Budapest&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
    { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?distance=10&f_E=1&f_TPR=r604800&keywords=teszt&location=Budapest&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
    { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?distance=10&f_E=1&keywords=teszt&location=Budapest&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
    { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?distance=10&f_E=2&keywords=teszt&location=Budapest&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
    { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?f_E=2&keywords=teszt&location=Budapest&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
    { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?distance=5&f_E=2&keywords=teszt&location=Budapest&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
];

  const client = await pool.connect();

  try {
    for (const p of SOURCES) {
      let html;
      try {
        html = await fetchText(p.url);
      } catch (err) {
        console.error(p.key, "fetch failed:", err.message);
        continue;
      }

      const rawItems = extractLinkedInJobs(html);

      let items = rawItems.filter(it => {
        const needKeywords = p.key === "LinkedIn";
        if (needKeywords && !matchesKeywords(it.title, it.description)) return false;
        if (!levelNotBlacklisted(it.title, it.description)) return false;
        if (!titleNotBlacklisted(it.title)) return false;
        return true;
      });


      for (const it of items) {
        try {
          await upsertJob(client, p.key, it);
        } catch (err) {
          console.error(err);
        }
      }

      console.log(`${p.key}: ${items.length} items processed.`);
    }
  } finally {
    console.log(`Script started at ${new Date().toISOString()}`);
    client.release();
  }

  return new Response("OK");
};
