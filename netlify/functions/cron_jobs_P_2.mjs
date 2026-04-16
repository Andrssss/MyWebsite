export const config = {
  schedule: "3 4-23 * * *",
};

import { processProfessionSources } from "./_profession_core.mjs";
import { withTimeout } from "./_error-logger.mjs";

const SOURCES = [
  { key: "profession-intern", label: "Profession – Intern", url: "https://www.profession.hu/allasok/it-uzemeltetes-telekommunikacio/budapest/1,25,23,gyakornok" },
];

export default withTimeout("cron_jobs_P_2", (request) =>
  processProfessionSources(SOURCES, "cron_jobs_P_2", request)
);
