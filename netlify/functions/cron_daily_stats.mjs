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
  "frissdiplomas",
];

const INTERN_TITLE_KEYWORDS = ["intern", "gyakornok", "trainee", "diák", "diákmunka"];
const ZERO_RANGE_EXPERIENCE_REGEX = String.raw`(^|[^0-9])0\s*[-–/]\s*[1-9][0-9]*([^0-9]|$)`;

// Specifikusabb kategóriák ELŐRE, általános "Fejlesztő" HÁTRA
// Minden job csak 1 kategóriába kerül (az első illeszkedő)
const JOB_CATEGORIES = [
  ["Webfejlesztés", ["Webmaster","Alkalmazásfejlesztő","frontend", "front-end", "front end", "backend", "back-end", "back end", "full stack", "fullstack", "full-stack", "react", "angular", "vue", "node.js", "nodejs", "web developer", "webfejlesztő", "web fejlesztő", "php", "django", "laravel", "next.js", "nuxt", "svelte", "typescript", "ui", "ux", "ui/ux", "ux/ui", "ui designer", "ux designer", "ux engineer", "user interface", "user experience", "figma", "design system", "interaction design", "product designer", "web design", "webdesign"]],
  ["Data / AI", ["ai automation","AI mérnök","copilot","ai prompt","conversation ai","ai applications","ai project","ai fejleszto","gen ai", "data engineer", "data scientist", "data science", "machine learning", "big data", "ai engineer", "ai developer", "artificial intelligence", "deep learning","adatbázis", "database" ,"nlp", "computer vision", "llm", "ml engineer", "ml ops", "mlops", "data platform", "generative ai"]],
  ["DevOps", ["AWS","Azure","cloud architect","devops", "sre", "site reliability", "cloud engineer", "platform engineer", "kubernetes", "docker", "terraform", "ci/cd", "cicd"]],
  ["QA / Tesztelő", ["tesztautomatizalo","testing","testing specialist","Tesztautomatizálási","automata tesztelo","fat","Tesztautomatizáló","Tesztautomatizálás","tesztmérnök","tesztelo","tester", "tesztelő", "qa", "quality assurance", "test engineer", "test automation", "automation engineer", "selenium"]],
  ["Helpdesk", ["helpdesk", "help desk", "service desk", "servicenow", "it support", "it technikus"]],
  ["Elemző", ["analyst","elemzési", "elemző", "elemzo", "analist", "analytics", "business analyst", "data analyst", "business intelligence", "bi developer", "bi specialist", "reporting", "riport", "power bi", "tableau"]],
  ["SAP", ["sap", "abap", "s/4hana", "s4hana", "sap hana", "sap basis", "sap fiori", "sap tanácsadó", "sap konzultáns", "sap consultant", "sap fejlesztő", "sap developer", "sap admin", "sap rendszergazda", "sap üzemeltető", "successfactors", "ariba", "concur"]],
  ["Security", ["IT Biztonságtechnikai","safety","security","biztonsági","Információbiztonsági", "Kiberbiztonsági","cybersecurity", "infosec", "penetration", "soc analyst", "security engineer"]],
  ["Hálózat / Infra", ["network", "hálózat", "infrastructure", "system admin", "rendszermérnök", "sysadmin", "linux admin", "windows admin", "it üzemeltető", "üzemeltetés"]],
  ["Hardware", ["karbantartási","eszközcserét","hardware", "embedded", "hw", "fpga", "pcb", "firmware"]],
  ["Mobil", ["android", "ios", "mobile developer", "flutter", "react native", "swift", "kotlin"]],
  ["Fejlesztő", ["C++","automation","autómatizálási","python", "java","software development","developer", "fejlesztő","fejlesztés","development", "fejleszto", "programozó", "software engineer", "engineer"]],
];

function categorizeJobs(rows) {
  const counts = {};
  for (const [cat] of JOB_CATEGORIES) counts[cat] = 0;
  counts["Egyéb"] = 0;
  for (const row of rows) {
    const title = (row.title || "").toLowerCase();
    const match = JOB_CATEGORIES.find(([, kws]) => kws.some((kw) => title.includes(kw.toLowerCase())));
    if (match) counts[match[0]]++;
    else counts["Egyéb"]++;
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
    const titleKeywordConditions = INTERN_TITLE_KEYWORDS.map(
      (_, i) => `LOWER(title) LIKE $${INTERN_SOURCES.length + i + 2}`
    ).join(" OR ");
    const experienceKeywordConditions = INTERN_TITLE_KEYWORDS.map(
      (_, i) => `LOWER(COALESCE(experience, '')) LIKE $${INTERN_SOURCES.length + i + 2}`
    ).join(" OR ");

    const params = [
      today,
      ...INTERN_SOURCES,
      ...INTERN_TITLE_KEYWORDS.map((kw) => `%${kw}%`),
    ];

    const { rows: internJobRows } = await client.query(
      `SELECT title FROM job_posts
       WHERE first_seen::date = $1
         AND (source IN (${sourcePlaceholders}) OR ${titleKeywordConditions} OR ${experienceKeywordConditions} OR COALESCE(experience, '') ~* '${ZERO_RANGE_EXPERIENCE_REGEX}')`,
      params
    );
    const internJobs = internJobRows.length;

    // Upsert a napi statisztikába
    await client.query(
      `INSERT INTO job_daily_stats (date, total_jobs, intern_jobs)
       VALUES ($1, $2, $3)
       ON CONFLICT (date)
       DO UPDATE SET total_jobs = EXCLUDED.total_jobs,
                     intern_jobs = EXCLUDED.intern_jobs`,
      [today, totalJobs, internJobs]
    );

    // Kategória bontás mentése (összes)
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

    // Intern kategória bontás mentése (prefix: "intern:")
    const internCategories = categorizeJobs(internJobRows);

    for (const { category, count } of internCategories) {
      await client.query(
        `INSERT INTO job_daily_categories (date, category, count)
         VALUES ($1, $2, $3)
         ON CONFLICT (date, category)
         DO UPDATE SET count = EXCLUDED.count`,
        [today, `intern:${category}`, count]
      );
    }

    console.log(`[daily_stats] ${today}: total=${totalJobs}, intern=${internJobs}, categories=${categories.length}, intern_categories=${internCategories.length}`);
  } catch (err) {
    console.error("[daily_stats] Error:", err);
  } finally {
    client.release();
  }
}
