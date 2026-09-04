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
import { appendDayIfMissing } from "./_daily_stats_store.mjs";
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

    const { skipped } = await appendDayIfMissing(today, {
      totalJobs,
      internJobs,
      categories,
      internCategories,
    });

    console.log(`[daily_stats] ${today}: total=${totalJobs}, intern=${internJobs}, categories=${categories.length}, intern_categories=${internCategories.length}${skipped ? " (already present, skipped)" : ""}`);
  } catch (err) {
    console.error("[daily_stats] Error:", err);
  } finally {
    client.release();
  }
});
