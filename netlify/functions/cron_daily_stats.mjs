// netlify/functions/cron_daily_stats.mjs
// Napi statisztika: hány álláshirdetés érkezett ma, abból hány diák/intern.
// Minden nap 23:59 UTC-kor fut.

export const config = {
  schedule: "59 23 * * *",
};

import pkg from "pg";
const { Pool } = pkg;
import { loadCategories } from "./load_categories.mjs";

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
  "tudatosdiak",
  "ydiak",
  "qdiak",
  "frissdiplomas",
];

const INTERN_TITLE_KEYWORDS = ["tehetsegprogram","tehetségprogram","talent pool","intern", "gyakornok", "trainee", "diák", "diákmunka"];
const ZERO_RANGE_EXPERIENCE_REGEX = String.raw`(^|[^0-9])(0\s*[-–/]\s*[1-9][0-9]*|0\s*(?:\+)?\s*(?:év|éves|ev|eves|year|years|yr|yrs))([^0-9]|$)`;

function categorizeJobs(rows, JOB_CATEGORIES) {
  const counts = {};
  for (const [cat] of JOB_CATEGORIES) counts[cat] = 0;
  counts["Egyéb"] = 0;

  for (const row of rows) {
    const title = (row.title || "").toLowerCase();
    const matches = JOB_CATEGORIES
      .filter(([, kws]) => kws.some((kw) => title.includes(kw.toLowerCase())))
      .map(([cat]) => cat);
    const withoutFallback = matches.filter((c) => c !== "Fejlesztő");
    const cats = withoutFallback.length > 0 ? withoutFallback : matches;

    if (cats.length > 0) {
      for (const cat of cats) counts[cat]++;
    } else {
      counts["Egyéb"]++;
    }
  }
  return Object.entries(counts)
    .filter(([, c]) => c > 0)
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count);
}

export default async function handler() {
  const client = await pool.connect();
  try {
    // Kategóriák betöltése adatbázisból
    const JOB_CATEGORIES = await loadCategories();

    // Előző napi dátum (UTC): a statisztikát mindig tegnapra mentjük
    const statsDate = new Date();
    statsDate.setUTCDate(statsDate.getUTCDate() );
    const today = statsDate.toISOString().slice(0, 10);

    // Mai összes új munka
    const { rows: totalRows } = await client.query(
      `SELECT COUNT(*)::int AS cnt
       FROM job_posts
       WHERE (first_seen AT TIME ZONE 'UTC')::date = $1`,
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
       WHERE (first_seen AT TIME ZONE 'UTC')::date = $1
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
      `SELECT title FROM job_posts WHERE (first_seen AT TIME ZONE 'UTC')::date = $1`,
      [today]
    );
    const categories = categorizeJobs(todayJobs, JOB_CATEGORIES);

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
    const internCategories = categorizeJobs(internJobRows, JOB_CATEGORIES);

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
