export const config = {
  schedule: "32 4-22 * * *",
};

import { processLinkedInSources } from "./_linkedin_core.mjs";
import { withTimeout } from "./_error-logger.mjs";

// Formerly cron_jobs_L_11 — renamed 2026-08-18 to close the gap left by
// merging L_9+L_10 into L_8; content (ai) unchanged.
const SOURCES = [
  // ai
  { key: "LinkedIn", label: "LinkedIn AI", url: "https://www.linkedin.com/jobs/search/?distance=0&f_E=1%2C2&f_TPR=r86400&geoId=104291169&keywords=ai&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
  { key: "LinkedIn", label: "LinkedIn AI", url: "https://www.linkedin.com/jobs/search/?distance=0&f_E=1%2C2&f_TPR=r604800&geoId=104291169&keywords=ai&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER", paginate: true, maxPages: 10 },
  { key: "LinkedIn", label: "LinkedIn AI", url: "https://www.linkedin.com/jobs/search/?distance=10&f_E=1%2C2&f_TPR=r86400&geoId=104291169&keywords=ai&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
  { key: "LinkedIn", label: "LinkedIn AI", url: "https://www.linkedin.com/jobs/search/?distance=10&f_E=1%2C2&f_TPR=r604800&geoId=104291169&keywords=ai&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER", paginate: true, maxPages: 10 },
];

export default withTimeout("cron_jobs_L_9-background", () =>
  processLinkedInSources(SOURCES, "cron_jobs_L_9-background")
);

