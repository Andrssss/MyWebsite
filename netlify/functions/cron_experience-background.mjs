export const config = {
  schedule: "23 4-22 * * *",
};


import { withTimeout } from "./_error-logger.mjs";
import {
  enrichExperience,
  extractLinkedInExperience,
} from "./_experience_core.mjs";

/* ======================
   MAIN
====================== */
export default withTimeout("cron_experience-background", async () => {
  console.log("=== EXPERIENCE ENRICHMENT (LinkedIn) STARTED ===");

  // (2026-07-07) Az INTERN_SOURCES 'diákmunka' tömeg-címkézés TÖRÖLVE innen:
  // minden diák-forrás scraper insertkor maga írja a címkét (DIAK_1/2/3,
  // atlasz, melodiak, pannondiak…), ráadásul a 20 perces ablak a :23-as
  // futásnál el sem érte a :55-ös dispatcher-futások sorait (28+ perc).
  // Szabály (user, 2026-07-07): LinkedIn-en KÍVÜL experience-t CSAK a scraper
  // írhat, a saját futása közben — backfill kizárólag LinkedInre létezik.

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
