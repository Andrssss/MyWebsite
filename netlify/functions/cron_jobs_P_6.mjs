export const config = {
  schedule: "24 6-22 * * *",
};

import { processProfessionSources } from "./_profession_core.mjs";
import { withTimeout } from "./_error-logger.mjs";

const SOURCES = [
  { key: "profession-intern", label: "Profession – Intern", url: "https://www.profession.hu/allasok/it-programozas-fejlesztes/budapest/1,10,23,intern" },
];

export default withTimeout("cron_jobs_P_6", (request) =>
  processProfessionSources(SOURCES, "cron_jobs_P_6", request)
);
