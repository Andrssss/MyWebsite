export const config = {
  schedule: "24 4-22 * * *",
};

import { processLinkedInSources } from "./_linkedin_core.mjs";
import { withTimeout } from "./_error-logger.mjs";

// Merged with the former cron_jobs_L_8 (Full Stack Engineer) on 2026-08-18 to
// free up a cron slot. The bare "Junior" search (all 4 variants) was dropped
// 2026-08-18 — no tech qualifier at all, LinkedIn matched it against ANY
// industry (confirmed live: a Portuguese wedding-planner "junior" listing, a
// cafe's finance trainee, etc. — see the LinkedIn keyword-relevance review
// earlier the same day).
const SOURCES = [
  // tester (overflow)
  { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?distance=10&f_E=1%2C2&f_TPR=r604800&geoId=104291169&keywords=tester&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER", paginate: true, maxPages: 10 },

  // Full Stack Engineer
  { key: "LinkedIn", label: "LinkedIn JR FULL-STACK", url: "https://www.linkedin.com/jobs/search/?distance=0&f_E=1%2C2&f_TPR=r86400&geoId=104291169&keywords=Full%20Stack%20Engineer&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
  { key: "LinkedIn", label: "LinkedIn JR FULL-STACK", url: "https://www.linkedin.com/jobs/search/?distance=0&f_E=1%2C2&f_TPR=r604800&geoId=104291169&keywords=Full%20Stack%20Engineer&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER", paginate: true, maxPages: 10 },
  { key: "LinkedIn", label: "LinkedIn JR FULL-STACK", url: "https://www.linkedin.com/jobs/search/?distance=10&f_E=1%2C2&f_TPR=r86400&geoId=104291169&keywords=Full%20Stack%20Engineer&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
  { key: "LinkedIn", label: "LinkedIn JR FULL-STACK", url: "https://www.linkedin.com/jobs/search/?distance=10&f_E=1%2C2&f_TPR=r604800&geoId=104291169&keywords=Full%20Stack%20Engineer&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER", paginate: true, maxPages: 10 },

  // devops (formerly cron_jobs_L_8, merged in 2026-08-18 after dropping the
  // non-tech "intern" keyword left it too small to stay standalone)
  { key: "LinkedIn", label: "LinkedIn DevOps", url: "https://www.linkedin.com/jobs/search/?distance=0&f_E=1%2C2&f_TPR=r86400&geoId=104291169&keywords=DevOps&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
  { key: "LinkedIn", label: "LinkedIn DevOps", url: "https://www.linkedin.com/jobs/search/?distance=0&f_E=1%2C2&f_TPR=r604800&geoId=104291169&keywords=DevOps&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER", paginate: true, maxPages: 10 },
  { key: "LinkedIn", label: "LinkedIn DevOps", url: "https://www.linkedin.com/jobs/search/?distance=10&f_E=1%2C2&f_TPR=r86400&geoId=104291169&keywords=DevOps&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
  { key: "LinkedIn", label: "LinkedIn DevOps", url: "https://www.linkedin.com/jobs/search/?distance=10&f_E=1%2C2&f_TPR=r604800&geoId=104291169&keywords=DevOps&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER", paginate: true, maxPages: 10 },
];

export default withTimeout("cron_jobs_L_7-background", () =>
  processLinkedInSources(SOURCES, "cron_jobs_L_7-background")
);
