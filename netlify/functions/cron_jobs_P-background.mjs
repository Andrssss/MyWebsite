import { processProfessionSources } from "./_profession_core.mjs";
import { flushErrors } from "./_error-logger.mjs";

const BASE_JOB_NAME = "cron_jobs_P-background";

/**
 * Unified Profession background worker.
 *
 * Body shape:
 *   {
 *     jobName: "P_1",                       // logical task id, used in logs/error reports
 *     url: "https://www.profession.hu/...", // listing URL to scrape
 *     startPage?: 1,                        // optional, defaults to 1
 *     maxPages?: 15,                        // optional, defaults to Infinity
 *     suffix?: "a"                          // optional, distinguishes split halves
 *   }
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

  const { jobName, url, suffix } = body || {};
  if (!jobName || !url) {
    return new Response("Missing jobName or url", { status: 400 });
  }

  const startPage = typeof body.startPage === "number" ? body.startPage : 1;
  const maxPages = typeof body.maxPages === "number" ? body.maxPages : Infinity;

  // Per-invocation log/error tag — keeps split halves distinguishable in logs.
  const fullJobName = suffix ? `${BASE_JOB_NAME}-${jobName}-${suffix}` : `${BASE_JOB_NAME}-${jobName}`;

  console.log(
    `[${fullJobName}] starting pages ${startPage}–${maxPages === Infinity ? "∞" : startPage + maxPages - 1} url=${url}`
  );

  const sources = [{ key: "profession-intern", label: "Profession – Intern", url }];
  const fakeRequest = new Request("https://localhost/.netlify/functions/" + fullJobName, { method: "GET" });

  let response;
  try {
    response = await processProfessionSources(sources, fullJobName, fakeRequest, { startPage, maxPages });
  } finally {
    await flushErrors(fullJobName).catch(() => {});
  }
  return response;
};
