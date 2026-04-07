// netlify/functions/cron_stats_cleanup.mjs
// Havonta egyszer (1-jén 02:00 UTC) kimenti a 3 hónapnál régebbi
// job_daily_stats és job_daily_categories adatokat Netlify Blobs-ba,
// majd törli őket az adatbázisból.

export const config = {
  schedule: "0 2 1 * *", // Minden hónap 1-jén 02:00 UTC
};

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

export default async function handler() {
  const client = await pool.connect();
  try {
    // 3 hónappal ezelőtti dátum
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - 3);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    // Régi adatok lekérése
    const { rows: oldStats } = await client.query(
      `SELECT * FROM job_daily_stats WHERE date < $1 ORDER BY date`,
      [cutoffStr]
    );
    const { rows: oldCategories } = await client.query(
      `SELECT * FROM job_daily_categories WHERE date < $1 ORDER BY date, category`,
      [cutoffStr]
    );

    if (oldStats.length === 0 && oldCategories.length === 0) {
      console.log("[stats_cleanup] Nincs régi adat, kihagyva.");
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
          cutoff: cutoffStr,
          stats: oldStats,
          categories: oldCategories,
        },
        null,
        2
      ),
      { metadata: { type: "stats-archive" } }
    );

    // Törlés az adatbázisból
    const { rowCount: deletedStats } = await client.query(
      `DELETE FROM job_daily_stats WHERE date < $1`,
      [cutoffStr]
    );
    const { rowCount: deletedCats } = await client.query(
      `DELETE FROM job_daily_categories WHERE date < $1`,
      [cutoffStr]
    );

    console.log(
      `[stats_cleanup] Archived to ${key}: stats=${oldStats.length}, categories=${oldCategories.length}. Deleted: stats=${deletedStats}, categories=${deletedCats}`
    );
  } catch (err) {
    console.error("[stats_cleanup] Error:", err);
  } finally {
    client.release();
  }
}
