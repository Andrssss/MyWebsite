export const config = {
  schedule: "23 4-22 * * *",
};


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
