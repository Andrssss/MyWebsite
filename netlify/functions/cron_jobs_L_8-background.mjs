export const config = {
  schedule: "28 4-22 * * *",
};

import { processLinkedInSources } from "./_linkedin_core.mjs";
import { withTimeout } from "./_error-logger.mjs";

// Formerly cron_jobs_L_9 (DevOps) — merged with the former cron_jobs_L_10
// (intern) on 2026-08-18 to free up a cron slot; renamed L_9 -> L_8 to close
// the resulting gap. Entry count (8) stays in the safe range of the
// never-merged shards (L_1/L_2/L_4/L_5/L_6, 7 each).
const SOURCES = [
  // devops
  { key: "LinkedIn", label: "LinkedIn DevOps", url: "https://www.linkedin.com/jobs/search/?distance=0&f_E=1%2C2&f_TPR=r86400&geoId=104291169&keywords=DevOps&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
  { key: "LinkedIn", label: "LinkedIn DevOps", url: "https://www.linkedin.com/jobs/search/?distance=0&f_E=1%2C2&f_TPR=r604800&geoId=104291169&keywords=DevOps&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER", paginate: true, maxPages: 10 },
  { key: "LinkedIn", label: "LinkedIn DevOps", url: "https://www.linkedin.com/jobs/search/?distance=10&f_E=1%2C2&f_TPR=r86400&geoId=104291169&keywords=DevOps&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
  { key: "LinkedIn", label: "LinkedIn DevOps", url: "https://www.linkedin.com/jobs/search/?distance=10&f_E=1%2C2&f_TPR=r604800&geoId=104291169&keywords=DevOps&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER", paginate: true, maxPages: 10 },

  // intern
  { key: "LinkedIn", label: "LinkedIn INTERN", url: "https://www.linkedin.com/jobs/search/?distance=0&f_E=1%2C2&f_TPR=r86400&geoId=104291169&keywords=intern&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
  { key: "LinkedIn", label: "LinkedIn INTERN", url: "https://www.linkedin.com/jobs/search/?distance=0&f_E=1%2C2&f_TPR=r604800&geoId=104291169&keywords=intern&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER", paginate: true, maxPages: 10 },
  { key: "LinkedIn", label: "LinkedIn INTERN", url: "https://www.linkedin.com/jobs/search/?distance=10&f_E=1%2C2&f_TPR=r86400&geoId=104291169&keywords=intern&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
  { key: "LinkedIn", label: "LinkedIn INTERN", url: "https://www.linkedin.com/jobs/search/?distance=10&f_E=1%2C2&f_TPR=r604800&geoId=104291169&keywords=intern&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER", paginate: true, maxPages: 10 },
];

export default withTimeout("cron_jobs_L_8-background", () =>
  processLinkedInSources(SOURCES, "cron_jobs_L_8-background")
);

