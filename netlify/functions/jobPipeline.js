// netlify/functions/jobPipeline.js
//
// HOLT KÓD — a legelső LinkedIn-scraper maradványa (a fejléce még
// `linkedin_scraper.js`-nek hívja magát). A repóban semmi nem hivatkozik rá, a
// job_posts-ba nem ír, a mai LinkedIn-aratást a cron_jobs_L_1..L_8 végzi.
// 2026-08-28-ig viszont HITELESÍTÉS NÉLKÜL, élesben ki volt téve: bárki
// meghívhatta, és a mi függvényünkkel, a mi kimenő IP-nkről fetcheltetett
// linkedin.com-ot tetszőleges `keyword`/`geo`/`pages` paraméterrel (max 10 oldal
// × ~2s késleltetés futásidőben). Ezért ADMIN_SECRET mögé került — de igazából
// törölni kellene, nem védeni.
const https = require("https");
const cheerio = require("cheerio");
const { hasAdminSecret } = require("./_admin_identity_core");

// =====================
// Helper: fetch HTML
// =====================
function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(data));
      res.on("error", reject);
    }).on("error", reject);
  });
}

// =====================
// Delay helper
// =====================
function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =====================
// Normalize text
// =====================
function normalizeText(s) {
  return String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}

// =====================
// Extract jobs from HTML
// =====================
function extractJobs(html) {
  const $ = cheerio.load(html);
  const jobs = [];

  $("ul.jobs-search__results-list li").each((_, el) => {
    const title = normalizeText($(el).find("h3.base-search-card__title").text());
    const company = normalizeText($(el).find("h4.base-search-card__subtitle").text());
    const location = normalizeText($(el).find("span.job-search-card__location").text());
    const link = $(el).find("a.base-card__full-link").attr("href");

    if (title && link) {
      jobs.push({ title, company, location, url: link });
    }
  });

  return jobs;
}

// =====================
// Handler
// =====================
exports.handler = async (event) => {
  if (!hasAdminSecret(event)) {
    return {
      statusCode: 401,
      body: JSON.stringify({ error: "Unauthorized" }),
      headers: { "Content-Type": "application/json" },
    };
  }

  const qs = event.queryStringParameters || {};
  const pages = Math.min(parseInt(qs.pages || "3", 10), 10); // max 10 oldal
  const delay = Math.max(parseInt(qs.delay || "1500", 10), 500); // ms
  const keyword = qs.keyword || "developer";
  const geo = qs.geo || "100288700"; // Budapest GEO ID

  const allJobs = [];

  try {
    for (let i = 0; i < pages; i++) {
      const start = i * 25;
      const url = `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(keyword)}&location=Budapest&geoId=${geo}&start=${start}`;
      const html = await fetchText(url);
      const jobs = extractJobs(html);
      allJobs.push(...jobs);

      // random delay 1-3s
      await wait(delay + Math.floor(Math.random() * 1500));
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, jobsProcessed: allJobs.length, jobs: allJobs }),
      headers: { "Content-Type": "application/json" },
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ ok: false, error: err.message }),
      headers: { "Content-Type": "application/json" },
    };
  }
};
