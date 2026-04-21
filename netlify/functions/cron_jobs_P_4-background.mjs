import { processProfessionSources } from "./_profession_core.mjs";
import { flushErrors } from "./_error-logger.mjs";

const SOURCES = [
  { key: "profession-intern", label: "Profession – Intern", url: "https://www.profession.hu/allasok/programozo-fejleszto/budapest/1,10,23,0,75" },
];

const JOB_NAME = "cron_jobs_P_4-background";

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  const expected = process.env.CRON_SECRET;
  if (!expected || token !== expected) {
    return new Response("Unauthorized", { status: 401 });
  }

  let startPage = 1;
  let maxPages = Infinity;
  try {
    const body = await request.json();
    if (typeof body.startPage === "number") startPage = body.startPage;
    if (typeof body.maxPages === "number") maxPages = body.maxPages;
  } catch {
    // no body or invalid JSON — use defaults
  }

  console.log(`[${JOB_NAME}] starting pages ${startPage}–${maxPages === Infinity ? "∞" : startPage + maxPages - 1}`);

  const fakeRequest = new Request("https://localhost/.netlify/functions/" + JOB_NAME, { method: "GET" });

  let response;
  try {
    response = await processProfessionSources(SOURCES, JOB_NAME, fakeRequest, { startPage, maxPages });
  } finally {
    await flushErrors(JOB_NAME).catch(() => {});
  }
  return response;
};
