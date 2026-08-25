export const config = {
  schedule: "8 4-22 * * *",
};

import { processLinkedInSources } from "./_linkedin_core.mjs";
import { withTimeout } from "./_error-logger.mjs";

// Note: each keyword's distance=10/r86400 slice already runs in its owning
// shard (Test Automation: L_2, fejlesztő: L_1, Software Engineer: L_4, qa:
// L_5) — only the wide-radius/7-day *paginated* continuation belongs here.
// A prior version duplicated the already-covered r86400 entry alongside each
// one (double fetch + double DB upsert per hour, no new coverage); removed
// 2026-08-18. The tester overflow had no such continuation of its own (its
// r604800/paginate copy lives in L_7), so it was a pure duplicate and is
// dropped entirely.
const SOURCES = [
  // Test Automation (overflow)
  { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?distance=10&f_TPR=r604800&geoId=104291169&keywords=Test%20Automation&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER", paginate: true, maxPages: 10 },

  // fejleszto (overflow)
  { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?distance=10&f_TPR=r604800&geoId=104291169&keywords=fejleszt%C5%91&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER", paginate: true, maxPages: 10 },

  // Software Engineer (overflow)
  { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?distance=10&f_TPR=r604800&geoId=104291169&keywords=Software%20Engineer&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER", paginate: true, maxPages: 10 },

  // qa (overflow)
  { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?distance=10&f_TPR=r604800&geoId=104291169&keywords=qa&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER", paginate: true, maxPages: 10 },
];

export default withTimeout("cron_jobs_L_3-background", () =>
  processLinkedInSources(SOURCES, "cron_jobs_L_3-background")
);
