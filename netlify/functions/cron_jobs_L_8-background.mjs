export const config = {
  schedule: "28 4-22 * * *",
};

import { processLinkedInSources } from "./_linkedin_core.mjs";
import { withTimeout } from "./_error-logger.mjs";

// Formerly cron_jobs_L_11, renamed to L_9 earlier 2026-08-18, then renamed
// again to L_8 the same day after L_8's DevOps content got folded into L_7
// (the "intern" search that used to live in L_8 was dropped for being too
// generic — no tech qualifier). Content (ai) unchanged throughout.
const SOURCES = [
  // ai
  { key: "LinkedIn", label: "LinkedIn AI", url: "https://www.linkedin.com/jobs/search/?distance=0&f_E=1%2C2&f_TPR=r86400&geoId=104291169&keywords=ai&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
  { key: "LinkedIn", label: "LinkedIn AI", url: "https://www.linkedin.com/jobs/search/?distance=0&f_E=1%2C2&f_TPR=r604800&geoId=104291169&keywords=ai&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER", paginate: true, maxPages: 10 },
  { key: "LinkedIn", label: "LinkedIn AI", url: "https://www.linkedin.com/jobs/search/?distance=10&f_E=1%2C2&f_TPR=r86400&geoId=104291169&keywords=ai&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
  { key: "LinkedIn", label: "LinkedIn AI", url: "https://www.linkedin.com/jobs/search/?distance=10&f_E=1%2C2&f_TPR=r604800&geoId=104291169&keywords=ai&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER", paginate: true, maxPages: 10 },
];

export default withTimeout("cron_jobs_L_8-background", () =>
  processLinkedInSources(SOURCES, "cron_jobs_L_8-background")
);

