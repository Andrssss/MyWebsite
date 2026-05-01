import { processProfessionSources } from "./_profession_core.mjs";
import { flushErrors } from "./_error-logger.mjs";
import { enrichExperience, extractProfessionExperience } from "./_experience_core.mjs";

const BASE_JOB_NAME = "cron_jobs_P-background";

/**
 * Unified Profession background worker.
 * Body: { jobName: "P_1", url: "https://www.profession.hu/..." }
 */
export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  const expected = process.env.CRON_SECRET;
  if (!expected || token !== expected) {
    return new Response("Unauthorized", { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  const { jobName, url } = body || {};
  if (!jobName || !url) {
    return new Response("Missing jobName or url", { status: 400 });
  }

  const fullJobName = `${BASE_JOB_NAME}-${jobName}`;
  console.log(`[${fullJobName}] starting url=${url}`);

  const sources = [{ key: "profession-intern", label: "Profession – Intern", url }];
  const fakeRequest = new Request("https://localhost/.netlify/functions/" + fullJobName, { method: "GET" });

  let response;
  try {
    response = await processProfessionSources(sources, fullJobName, fakeRequest);

    // Enrich experience for newly inserted profession-intern rows
    try {
      await enrichExperience({
        sourceFilter: "source = 'profession-intern'",
        extract: extractProfessionExperience,
        label: "profession-intern",
        jobName: fullJobName,
      });
    } catch (err) {
      console.error(`[${fullJobName}] experience enrichment failed:`, err.message);
    }
  } finally {
    await flushErrors(fullJobName).catch(() => {});
  }
  return response;
};
