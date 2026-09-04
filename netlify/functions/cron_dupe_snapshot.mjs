// netlify/functions/cron_dupe_snapshot.mjs
//
// Writes the daily dupe-check Blob snapshot (see _dupe_snapshot.mjs for the
// full rationale) — replaces most of what used to be a full job_posts scan
// on every scraper run that needs a same-source/cross-source dupe check.
//
// Scheduled 23:45 UTC: after cron_linkedin_cleanup (23:10) so archived rows
// are already gone from job_posts, and before cron_daily_stats (23:59) and
// the next day's first scraper run (:00 UTC) so the snapshot always reflects
// a full day's postings before the dupe guards start relying on it again.

export const config = {
  schedule: "45 23 * * *",
};

import pkg from "pg";
const { Pool } = pkg;
import { withTimeout } from "./_error-logger.mjs";
import { writeDupeSnapshot } from "./_dupe_snapshot.mjs";

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

export default withTimeout("cron_dupe_snapshot", async function handler() {
  const client = await pool.connect();
  try {
    const result = await writeDupeSnapshot(client);
    console.log(`[dupe-snapshot] wrote ${result.rowCount} rows, generatedAt=${result.generatedAt}`);
  } finally {
    client.release();
  }
  return new Response("OK");
});
