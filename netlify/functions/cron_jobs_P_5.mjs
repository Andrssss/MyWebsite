export const config = {
  schedule: "23 4-23 * * *",
};

import { processProfessionSources } from "./_profession_core.mjs";
import { withTimeout } from "./_error-logger.mjs";

const SOURCES = [
  { key: "profession-intern", label: "Profession – Intern", url: "https://www.profession.hu/allasok/tesztelo-tesztmernok/budapest/1,10,23,0,80" },
];

export default withTimeout("cron_jobs_P_5", (request) =>
  processProfessionSources(SOURCES, "cron_jobs_P_5", request)
);
