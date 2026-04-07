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

    console.log(`[daily_stats] ${today}: total=${totalJobs}, intern=${internJobs}`);
  } catch (err) {
    console.error("[daily_stats] Error:", err);
  } finally {
    client.release();
  }
}
