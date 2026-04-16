export const config = {
  schedule: "22 4-23 * * *",
};

import { processProfessionSources } from "./_profession_core.mjs";
import { withTimeout } from "./_error-logger.mjs";

const SOURCES = [
  { key: "profession-intern", label: "Profession – Intern", url: "https://www.profession.hu/allasok/programozo-fejleszto/budapest/1,10,23,0,75" },
];

export default withTimeout("cron_jobs_P_4", (request) =>
  processProfessionSources(SOURCES, "cron_jobs_P_4", request)
);
