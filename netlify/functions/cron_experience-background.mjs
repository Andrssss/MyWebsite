export const config = {
  schedule: "32 4-22 * * *",
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
      // This job runs hourly (:23, see CRON_SCHEDULE.md) but enrichExperience's
      // default 30-minute first_seen lookback is narrower than that cadence —
      // rows inserted between :23 and :53 fall in a gap no run's window ever
      // covers, and a row whose fetch fails (LinkedIn rate-limiting/blocking is
      // common) never gets a retry once it ages out of a 30-minute window on an
      // hourly job. 180 minutes gives every row ~3 hourly attempts before it
      // permanently misses technologies/experience enrichment (2026-08-06 user
      // report: 188/723 active LinkedIn rows had technologies stuck null).
      intervalMinutes: 180,
    });
  } catch (err) {
    console.error("[cron_experience-background] LinkedIn enrichment failed:", err.message);
  }

  // A forrás-független technologies-backfill (enrichTechnologies) 2026-07-08-án
  // KIVÉVE (user-döntés): a felgyülemlett backlog le lett darálva, folyamatos
  // óránkénti 150-fetches sweep nem kell. A technologies innentől kizárólag a
  // scraperek insert-útjain és a fenti LinkedIn experience-enrichment
  // COALESCE-ágán íródik — a title/level-rövidzáras sorok (talent junior/medior
  // cím, bankok gyakornok-szint, erste) tudatosan címke nélkül maradnak.
  console.log("=== EXPERIENCE ENRICHMENT (LinkedIn) FINISHED ===");
  return new Response("OK");
});
