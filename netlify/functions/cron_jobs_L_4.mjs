export const config = {
  schedule: "6 4-23 * * *",
};

import { processLinkedInSources } from "./_linkedin_core.mjs";
import { withTimeout } from "./_error-logger.mjs";

const SOURCES = [
  // python
  { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?distance=0&f_E=2&f_TPR=r86400&geoId=104291169&keywords=python&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
  { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?distance=0&f_E=1&f_TPR=r86400&geoId=104291169&keywords=python&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
  { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?distance=0&f_E=2&f_TPR=r604800&geoId=104291169&keywords=python&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
  { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?distance=0&f_E=1&f_TPR=r604800&geoId=104291169&keywords=python&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
  { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?distance=10&f_E=2&f_TPR=r86400&geoId=104291169&keywords=python&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
  { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?distance=10&f_E=1&f_TPR=r86400&geoId=104291169&keywords=python&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
  { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?distance=10&f_E=2&f_TPR=r604800&geoId=104291169&keywords=python&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
  { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?distance=10&f_E=1&f_TPR=r604800&geoId=104291169&keywords=python&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER" },

  // Software Engineer
  { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?distance=0&f_E=2&f_TPR=r86400&geoId=104291169&keywords=Software%20Engineer&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
  { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?distance=0&f_E=1&f_TPR=r86400&geoId=104291169&keywords=Software%20Engineer&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
  { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?distance=0&f_E=2&f_TPR=r604800&geoId=104291169&keywords=Software%20Engineer&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
  { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?distance=0&f_E=1&f_TPR=r604800&geoId=104291169&keywords=Software%20Engineer&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
  { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?distance=10&f_E=2&f_TPR=r86400&geoId=104291169&keywords=Software%20Engineer&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
];

export default withTimeout("cron_jobs_L_4", () =>
  processLinkedInSources(SOURCES, "cron_jobs_L_4")
);