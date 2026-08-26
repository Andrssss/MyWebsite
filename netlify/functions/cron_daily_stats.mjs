// netlify/functions/cron_daily_stats.mjs
// Napi statisztika: hány álláshirdetés érkezett ma, abból hány diák/intern.
// Minden nap 23:59 UTC-kor fut.
//
// A kategorizálás és a nap-összesítés a KÖZÖS _stats_core.mjs-ben lakik
// (ugyanaz a szabálykészlet, amit a board használ) — itt szándékosan NINCS
// másolat belőle, mert pont az ilyen másolatok csúsztak el a frontendtől.

export const config = {
  schedule: "59 23 * * *",
};

import pkg from "pg";
const { Pool } = pkg;
import { loadCategories } from "./load_categories.mjs";
import { computeDayStats } from "./_stats_core.mjs";
import { withTimeout } from "./_error-logger.mjs";

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

export default withTimeout("cron_daily_stats", async function handler() {
  const client = await pool.connect();
  try {
    // Kategóriák betöltése adatbázisból
    const JOB_CATEGORIES = await loadCategories();

    const today = new Date().toISOString().slice(0, 10);

    // A mai nap összes új munkája (title + source + experience kell a
    // senior-kizáráshoz és a diák/intern felismeréshez)
    const { rows: todayRows } = await client.query(
      `SELECT title, source, experience
       FROM job_posts
       WHERE (first_seen AT TIME ZONE 'UTC')::date = $1`,
      [today]
    );

    const { totalJobs, internJobs, categories, internCategories } =
      computeDayStats(todayRows, JOB_CATEGORIES);

    // Upsert a napi statisztikába
    await client.query(
      `INSERT INTO job_daily_stats (date, total_jobs, intern_jobs)
       VALUES ($1, $2, $3)
       ON CONFLICT (date)
       DO NOTHING`,
      [today, totalJobs, internJobs]
    );

    // Kategória bontás mentése (összes, senior nélkül)
    for (const { category, count } of categories) {
      await client.query(
        `INSERT INTO job_daily_categories (date, category, count)
         VALUES ($1, $2, $3)
         ON CONFLICT (date, category)
          DO NOTHING`,
        [today, category, count]
      );
    }

    // Intern kategória bontás mentése (prefix: "intern:")
    for (const { category, count } of internCategories) {
      await client.query(
        `INSERT INTO job_daily_categories (date, category, count)
         VALUES ($1, $2, $3)
         ON CONFLICT (date, category)
          DO NOTHING`,
        [today, `intern:${category}`, count]
      );
    }

    console.log(`[daily_stats] ${today}: total=${totalJobs}, intern=${internJobs}, categories=${categories.length}, intern_categories=${internCategories.length}`);
  } catch (err) {
    console.error("[daily_stats] Error:", err);
  } finally {
    client.release();
  }
});
