export const config = {
  schedule: "2 6-22 * * *",
};

import { processLinkedInSources } from "./_linkedin_core.mjs";
import { withTimeout } from "./_error-logger.mjs";

const SOURCES = [
  // test
  { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?distance=0&f_E=2&f_TPR=r86400&geoId=104291169&keywords=test&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
  { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?distance=0&f_E=1&f_TPR=r86400&geoId=104291169&keywords=test&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
  { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?distance=0&f_E=2&f_TPR=r604800&geoId=104291169&keywords=test&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
  { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?distance=0&f_E=1&f_TPR=r604800&geoId=104291169&keywords=test&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
  { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?distance=10&f_E=2&f_TPR=r86400&geoId=104291169&keywords=test&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
  { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?distance=10&f_E=1&f_TPR=r86400&geoId=104291169&keywords=test&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
  { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?distance=10&f_E=2&f_TPR=r604800&geoId=104291169&keywords=test&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
  { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?distance=10&f_E=1&f_TPR=r604800&geoId=104291169&keywords=test&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER" },

  // Test Automation
  { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?distance=0&f_E=2&f_TPR=r86400&geoId=104291169&keywords=Test%20Automation&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
  { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?distance=0&f_E=1&f_TPR=r86400&geoId=104291169&keywords=Test%20Automation&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
  { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?distance=0&f_E=2&f_TPR=r604800&geoId=104291169&keywords=Test%20Automation&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
  { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?distance=0&f_E=1&f_TPR=r604800&geoId=104291169&keywords=Test%20Automation&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
  { key: "LinkedIn", label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?distance=10&f_E=2&f_TPR=r86400&geoId=104291169&keywords=Test%20Automation&location=Budapest%2C%20Budapest%2C%20Hungary&origin=JOB_SEARCH_PAGE_JOB_FILTER" },
];

export default withTimeout("cron_jobs_L_2-background", () =>
  processLinkedInSources(SOURCES, "cron_jobs_L_2-background")
);