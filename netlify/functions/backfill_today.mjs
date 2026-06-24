// Manuálisan futtatandó script: csak a mai napot tölti be.
// Futtatás: node --env-file=.env netlify/functions/backfill_today.mjs

import pkg from "pg";
const { Pool } = pkg;
import { loadCategories } from "./load_categories.mjs";
import { INTERNSHIP_KEYWORDS, INTERN_SOURCES } from "./_experience_core.mjs";
import { processDay } from "./backfill_daily_stats.mjs";

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

async function main() {
  const client = await pool.connect();
  try {
    const JOB_CATEGORIES = await loadCategories();
    const today = new Date();
    const dateStr = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()))
      .toISOString()
      .slice(0, 10);

    console.log(`[backfill_today] Feldolgozás: ${dateStr}`);
    await processDay(client, dateStr, JOB_CATEGORIES);
    console.log("[backfill_today] Kész!");
  } catch (err) {
    console.error("[backfill_today] Hiba:", err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
