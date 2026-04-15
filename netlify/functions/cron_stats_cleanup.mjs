// netlify/functions/cron_stats_cleanup.mjs
// Havonta egyszer (1-jén 02:00 UTC) kimenti az előző teljes hónap
// job_daily_stats és job_daily_categories adatait Netlify Blobs-ba,
// majd törli őket az adatbázisból.



import { getStore } from "@netlify/blobs";
import pkg from "pg";
const { Pool } = pkg;

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

const STORE_NAME = "stats-backups";

function budapestDateStamp() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Budapest",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function monthRangeForPreviousMonth() {
  const now = new Date();
  const currentMonthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  );
  const previousMonthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)
  );

  return {
    start: previousMonthStart.toISOString().slice(0, 10),
    end: currentMonthStart.toISOString().slice(0, 10),
  };
}

export default async function handler() {
  const client = await pool.connect();
  try {
    // Az előző teljes hónap intervalluma: [monthStart, monthEnd)
    const { start: monthStart, end: monthEnd } = monthRangeForPreviousMonth();

    // Előző havi adatok lekérése
    const { rows: oldStats } = await client.query(
      `SELECT * FROM job_daily_stats WHERE date >= $1 AND date < $2 ORDER BY date`,
      [monthStart, monthEnd]
    );
    const { rows: oldCategories } = await client.query(
      `SELECT * FROM job_daily_categories WHERE date >= $1 AND date < $2 ORDER BY date, category`,
      [monthStart, monthEnd]
    );

    if (oldStats.length === 0 && oldCategories.length === 0) {
      console.log(
        `[stats_cleanup] Nincs archiválható adat a ${monthStart} - ${monthEnd} időszakra, kihagyva.`
      );
      return;
    }

    // Mentés Netlify Blobs-ba
    const today = budapestDateStamp();
    const key = `stats-archive-${today}.json`;
    const store = getStore(STORE_NAME);

    await store.set(
      key,
      JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          rangeStart: monthStart,
          rangeEnd: monthEnd,
          stats: oldStats,
          categories: oldCategories,
        },
        null,
        2
      ),
      { metadata: { type: "stats-archive" } }
    );

    // Előző havi adatok törlése az adatbázisból
    const { rowCount: deletedStats } = await client.query(
      `DELETE FROM job_daily_stats WHERE date >= $1 AND date < $2`,
      [monthStart, monthEnd]
    );
    const { rowCount: deletedCats } = await client.query(
      `DELETE FROM job_daily_categories WHERE date >= $1 AND date < $2`,
      [monthStart, monthEnd]
    );

    console.log(
      `[stats_cleanup] Archived to ${key} for ${monthStart} - ${monthEnd}: stats=${oldStats.length}, categories=${oldCategories.length}. Deleted: stats=${deletedStats}, categories=${deletedCats}`
    );
  } catch (err) {
    console.error("[stats_cleanup] Error:", err);
  } finally {
    client.release();
  }
}
