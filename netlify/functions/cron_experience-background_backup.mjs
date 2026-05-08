export const config = {
  schedule: "55 4-22 * * *",
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

  // Backup retry: LinkedIn rows that still have '-' or NULL experience
  // (e.g. failed on first attempt due to timeout)
  try {
    await enrichExperience({
      sourceFilter: "source = 'LinkedIn'",
      extract: extractLinkedInExperience,
      label: "LinkedIn",
      jobName: "cron_experience-background",
      intervalMinutes: 180, // 3 hours
      experienceCondition: "(experience IS NULL OR experience = '-')",
    });
  } catch (err) {
    console.error("[cron_experience-background] LinkedIn enrichment failed:", err.message);
  }

  console.log("=== EXPERIENCE ENRICHMENT (LinkedIn) FINISHED ===");
  return new Response("OK");
});
