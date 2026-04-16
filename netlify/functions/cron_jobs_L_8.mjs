export const config = {
  schedule: "16 4-23 * * *",
};

import { processLinkedInSources } from "./_linkedin_core.mjs";
import { withTimeout } from "./_error-logger.mjs";

const SOURCES = [
  // Full Stack Engineer
  { key: "LinkedIn", label: "LinkedIn JR FULL-STACK", url: "https://www.linkedin.com/jobs/search/?distance=0&f_E=2&f_TPR=r86400&geoId=104291169&keywords=Full%20Stack%20Engineer&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
  { key: "LinkedIn", label: "LinkedIn JR FULL-STACK", url: "https://www.linkedin.com/jobs/search/?distance=0&f_E=1&f_TPR=r86400&geoId=104291169&keywords=Full%20Stack%20Engineer&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
  { key: "LinkedIn", label: "LinkedIn JR FULL-STACK", url: "https://www.linkedin.com/jobs/search/?distance=0&f_E=2&f_TPR=r604800&geoId=104291169&keywords=Full%20Stack%20Engineer&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
  { key: "LinkedIn", label: "LinkedIn JR FULL-STACK", url: "https://www.linkedin.com/jobs/search/?distance=0&f_E=1&f_TPR=r604800&geoId=104291169&keywords=Full%20Stack%20Engineer&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
  { key: "LinkedIn", label: "LinkedIn JR FULL-STACK", url: "https://www.linkedin.com/jobs/search/?distance=10&f_E=2&f_TPR=r86400&geoId=104291169&keywords=Full%20Stack%20Engineer&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
  { key: "LinkedIn", label: "LinkedIn JR FULL-STACK", url: "https://www.linkedin.com/jobs/search/?distance=10&f_E=1&f_TPR=r86400&geoId=104291169&keywords=Full%20Stack%20Engineer&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
  { key: "LinkedIn", label: "LinkedIn JR FULL-STACK", url: "https://www.linkedin.com/jobs/search/?distance=10&f_E=2&f_TPR=r604800&geoId=104291169&keywords=Full%20Stack%20Engineer&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
  { key: "LinkedIn", label: "LinkedIn JR FULL-STACK", url: "https://www.linkedin.com/jobs/search/?distance=10&f_E=1&f_TPR=r604800&geoId=104291169&keywords=Full%20Stack%20Engineer&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER" },

  // Junior
  { key: "LinkedIn", label: "LinkedIn JR DEVELOPER", url: "https://www.linkedin.com/jobs/search/?distance=0&f_E=2&f_TPR=r86400&geoId=104291169&keywords=Junior&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
  { key: "LinkedIn", label: "LinkedIn JR DEVELOPER", url: "https://www.linkedin.com/jobs/search/?distance=0&f_E=1&f_TPR=r86400&geoId=104291169&keywords=Junior&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
  { key: "LinkedIn", label: "LinkedIn JR DEVELOPER", url: "https://www.linkedin.com/jobs/search/?distance=0&f_E=2&f_TPR=r604800&geoId=104291169&keywords=Junior&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
];

export default withTimeout("cron_jobs_L_8", () =>
  processLinkedInSources(SOURCES, "cron_jobs_L_8")
);