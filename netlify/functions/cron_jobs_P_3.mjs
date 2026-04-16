export const config = {
  schedule: "5 4-23 * * *",
};

import { processProfessionSources } from "./_profession_core.mjs";
import { withTimeout } from "./_error-logger.mjs";

const SOURCES = [
  { key: "profession-intern", label: "Profession – Intern", url: "https://www.profession.hu/allasok/adatbazisszakerto/budapest/1,10,23,0,200" },
];

export default withTimeout("cron_jobs_P_3", (request) =>
  processProfessionSources(SOURCES, "cron_jobs_P_3", request)
);
