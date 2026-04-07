// netlify/functions/cron_daily_stats.mjs
// Napi statisztika: hány álláshirdetés érkezett ma, abból hány diák/intern.
// Minden nap 23:59 UTC-kor fut.

export const config = {
  schedule: "59 23 * * *",
};

import pkg from "pg";
const { Pool } = pkg;

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

const INTERN_SOURCES = [
  "minddiak",
  "muisz",
  "zyntern",
  "schonherz",
  "prodiak",
  "tudasdiak",
  "otp",
  "vizmuvek",
  "tudatosdiak",
  "ydiak",
  "qdiak",
];

const INTERN_TITLE_KEYWORDS = ["intern", "gyakornok", "trainee", "diák", "diákmunka"];

const JOB_CATEGORIES = {
  "Fejlesztő": ["developer", "fejlesztő", "fejleszto", "programozó", "software engineer"],
  "QA / Tesztelő": ["tester", "tesztelő", "qa", "quality", "test"],
  "DevOps": ["devops", "sre", "site reliability"],
  "Helpdesk": ["helpdesk", "help desk", "service desk", "servicenow"],
  "Elemző": ["analyst", "elemző", "elemzo", "analist", "analytics", "business analyst", "data analyst", "business intelligence", "bi developer", "bi specialist", "reporting", "riport"],
  "Data / AI": ["data engineer", "data scientist", "machine learning", "big data"],
  "SAP": ["sap", "abap"],
  "Webfejlesztés": ["frontend", "backend", "full stack", "fullstack", "full-stack", "react", "angular", "vue", "node.js", "nodejs", "web developer", "webfejlesztő", "web fejlesztő", "php", "django", "laravel", "html", "css", "javascript"],
  "Security": ["security", "cybersecurity"],
  "Hálózat / Infra": ["network", "hálózat", "infrastructure", "system admin", "rendszermérnök"],
  "Hardware": ["hardware", "embedded", "hw verification"],
};

function categorizeJobs(rows) {
  const counts = {};
  for (const cat of Object.keys(JOB_CATEGORIES)) counts[cat] = 0;
  counts["Egyéb"] = 0;
  for (const row of rows) {
    const title = (row.title || "").toLowerCase();
    const matched = Object.entries(JOB_CATEGORIES)
      .filter(([, kws]) => kws.some((kw) => title.includes(kw.toLowerCase())))
      .map(([cat]) => cat);
    if (matched.length === 0) counts["Egyéb"]++;
    else for (const cat of matched) counts[cat]++;
  }
  return Object.entries(counts)
    .filter(([, c]) => c > 0)
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count);
}

export default async function handler() {
  const client = await pool.connect();
  try {
    // Mai dátum (UTC)
    const today = new Date().toISOString().slice(0, 10);

    // Mai összes új munka
    const { rows: totalRows } = await client.query(
      `SELECT COUNT(*)::int AS cnt
       FROM job_posts
       WHERE first_seen::date = $1`,
      [today]
    );
    const totalJobs = totalRows[0]?.cnt ?? 0;

    // Mai diák/intern munkák: forrás alapján VAGY cím kulcsszó alapján
    const sourcePlaceholders = INTERN_SOURCES.map((_, i) => `$${i + 2}`).join(",");
    const keywordConditions = INTERN_TITLE_KEYWORDS.map(
      (_, i) => `LOWER(title) LIKE $${INTERN_SOURCES.length + i + 2}`
    ).join(" OR ");

    const params = [
      today,
      ...INTERN_SOURCES,
      ...INTERN_TITLE_KEYWORDS.map((kw) => `%${kw}%`),
    ];

    const { rows: internRows } = await client.query(
      `SELECT COUNT(*)::int AS cnt
       FROM job_posts
       WHERE first_seen::date = $1
         AND (source IN (${sourcePlaceholders}) OR ${keywordConditions})`,
      params
    );
    const internJobs = internRows[0]?.cnt ?? 0;

    // Upsert a napi statisztikába
    await client.query(
      `INSERT INTO job_daily_stats (date, total_jobs, intern_jobs)
       VALUES ($1, $2, $3)
       ON CONFLICT (date)
       DO UPDATE SET total_jobs = EXCLUDED.total_jobs,
                     intern_jobs = EXCLUDED.intern_jobs`,
      [today, totalJobs, internJobs]
    );

    // Kategória bontás mentése
    const { rows: todayJobs } = await client.query(
      `SELECT title FROM job_posts WHERE first_seen::date = $1`,
      [today]
    );
    const categories = categorizeJobs(todayJobs);

    for (const { category, count } of categories) {
      await client.query(
        `INSERT INTO job_daily_categories (date, category, count)
         VALUES ($1, $2, $3)
         ON CONFLICT (date, category)
         DO UPDATE SET count = EXCLUDED.count`,
        [today, category, count]
      );
    }

    console.log(`[daily_stats] ${today}: total=${totalJobs}, intern=${internJobs}, categories=${categories.length}`);
  } catch (err) {
    console.error("[daily_stats] Error:", err);
  } finally {
    client.release();
  }
}
