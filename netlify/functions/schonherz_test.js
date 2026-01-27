// File: schonherz_test.mjs
import puppeteer from "puppeteer";

// ---------------- CATEGORY KEYWORDS ----------------
const DEV_KEYWORDS = ["fejleszt","developer","engineer","programoz","software","backend","frontend","fullstack","android","ios","java","c++","c#","python","javascript","react","angular","vue","node","php","ruby","rails"];
const DATA_KEYWORDS = ["data","adat","analyst","bi","qlik","power bi","sql"];
const QA_KEYWORDS = ["teszt","tester","qa"];
const OPS_KEYWORDS = ["operations","operation","monitoring","support","deployment","platform"];

function normalizeText(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function categorizeJob(title) {
  const t = normalizeText(title);
  if (DEV_KEYWORDS.some(k => t.includes(k))) return "DEV";
  if (DATA_KEYWORDS.some(k => t.includes(k))) return "DATA";
  if (QA_KEYWORDS.some(k => t.includes(k))) return "QA";
  if (OPS_KEYWORDS.some(k => t.includes(k))) return "OPS";
  return "OTHER";
}

// ---------------- SCRAPE ONE PAGE ----------------
async function scrapeCategory(url) {
  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();

  await page.goto(url, { waitUntil: "networkidle2" });

  // várjuk meg, hogy az ad-list div megjelenjen
  await page.waitForSelector(".ad-list .col-md-8", { timeout: 5000 }).catch(() => {});

  const jobs = await page.evaluate(() => {
    return Array.from(document.querySelectorAll(".ad-list .col-md-8")).map(el => {
      const a = el.querySelector("h4 a[href*='/diakmunka/']");
      return a ? { title: a.innerText.trim(), url: a.href } : null;
    }).filter(Boolean);
  });

  await browser.close();

  // Kategorizálás
  return jobs.map(job => ({
    ...job,
    category: categorizeJob(job.title)
  }));
}

// ---------------- MAIN HANDLER ----------------
export default async function handler() {
  const CATEGORY_URLS = [
    "https://schonherz.hu/diakmunkak/budapest/fejleszto---tesztelo",
    "https://schonherz.hu/diakmunkak/budapest/mernoki",
    "https://schonherz.hu/diakmunkak/budapest/it-uzemeltetes"
  ];

  let allJobs = [];

  try {
    for (const url of CATEGORY_URLS) {
      const jobs = await scrapeCategory(url);
      allJobs = allJobs.concat(jobs);
    }

    return new Response(JSON.stringify({
      ok: true,
      count: allJobs.length,
      jobs: allJobs
    }, null, 2), {
      headers: { "content-type": "application/json" }
    });
  } catch (e) {
    console.error("Handler error:", e);
    return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500 });
  }
}
