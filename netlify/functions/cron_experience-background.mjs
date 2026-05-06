export const config = {
  schedule: "23 4-22 * * *",
};

/* =========================
   EXPERIENCE ENRICHMENT — LinkedIn only.

   cvcentrum, kuka, dreamjobs, melonjobs, talent) has been moved back into
   the corresponding source background cron files:

     - cron_jobs_P-background.mjs   → profession-intern
     - cron_jobs_C_1-background.mjs / C_2 → cvcentrum-gyakornok-it
     - cron_jobs_MIX-background.mjs → kuka, dreamjobs, melonjobs
     - cron_jobs_T-background.mjs   → talent

   This file still handles:
     - bulk auto-mark of intern-source rows as "diákmunka"
     - LinkedIn experience enrichment (kept here intentionally)
   ========================= */

import { Pool } from "pg";
import { withTimeout } from "./_error-logger.mjs";
import {
  enrichExperience,
  extractLinkedInExperience,
  INTERN_SOURCES,
} from "./_experience_core.mjs";

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL missing");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

/* ======================
   MAIN
====================== */
export default withTimeout("cron_experience-background", async () => {
  console.log("=== EXPERIENCE ENRICHMENT (LinkedIn) STARTED ===");
  const client = await pool.connect();

  try {
    // Intern-centric sources: mark recent rows as diákmunka, no fetch
    const internSourcePlaceholders = INTERN_SOURCES.map((_, i) => `$${i + 1}`).join(",");
    const { rowCount: internMarked } = await client.query(
      `UPDATE job_posts
       SET experience = 'diákmunka'
       WHERE (experience IS NULL OR experience = '-')
         AND source IN (${internSourcePlaceholders})
         AND first_seen >= NOW() - INTERVAL '20 minutes'`,
      INTERN_SOURCES
    );
    console.log(`[intern-sources] ${internMarked} álláshirdetés megjelölve: diákmunka`);
  } finally {
    client.release();
  }

  // LinkedIn enrichment — re-run over recent LinkedIn rows whose experience is
  // not yet known. Rows already marked as "diákmunka" by the LinkedIn ingest
  // (based on the job title containing intern/trainee/gyakornok/etc.) are
  // skipped here to save fetches.
  try {
    await enrichExperience({
      sourceFilter: "source = 'LinkedIn'",
      extract: extractLinkedInExperience,
      label: "LinkedIn",
      jobName: "cron_experience-background",
      experienceCondition: "(experience IS NULL OR experience = '-')",
    });
  } catch (err) {
    console.error("[cron_experience-background] LinkedIn enrichment failed:", err.message);
  }

  console.log("=== EXPERIENCE ENRICHMENT (LinkedIn) FINISHED ===");
  return new Response("OK");
});
