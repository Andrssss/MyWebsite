import { processProfessionSources } from "./_profession_core.mjs";
import { flushErrors } from "./_error-logger.mjs";
import { enrichExperience, extractProfessionExperience } from "./_experience_core.mjs";

const BASE_JOB_NAME = "cron_jobs_P-background";

/**
 * Unified Profession background worker.
 * Body: { tasks: [{ jobName: "P_1", url: "https://..." }, ...] }
 *
 * All tasks share source key "profession-intern" — processProfessionSources
 * accumulates foundUrls across all of them and reconciles once at the end,
 * so no task overwrites the active-state set by any other task.
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

  const { tasks } = body || {};
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return new Response("Missing or empty tasks array", { status: 400 });
  }

  console.log(`[${BASE_JOB_NAME}] starting ${tasks.length} tasks`);

  const sources = tasks.map((t) => ({
    key: "profession-intern",
    label: t.jobName,
    url: t.url,
  }));
  const fakeRequest = new Request("https://localhost/.netlify/functions/" + BASE_JOB_NAME, { method: "GET" });

  let response;
  try {
    response = await processProfessionSources(sources, BASE_JOB_NAME, fakeRequest);

    // Enrich experience for newly inserted profession-intern rows
    try {
      await enrichExperience({
        sourceFilter: "source = 'profession-intern'",
        extract: extractProfessionExperience,
        label: "profession-intern",
        jobName: BASE_JOB_NAME,
      });
    } catch (err) {
      console.error(`[${BASE_JOB_NAME}] experience enrichment failed:`, err.message);
    }
  } finally {
    await flushErrors(BASE_JOB_NAME).catch(() => {});
  }
  return response;
};
