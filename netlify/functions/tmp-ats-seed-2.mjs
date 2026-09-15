// DISPOSABLE — 2026-09-15. Seeds two more real Workday tenants found during
// the ATS extension follow-up (ThermoFisher, Danaher — both confirmed live
// with dozens of Budapest-location mentions) via the real production
// ats-tenants endpoint, using the real AI_INGEST_TOKEN/CRON_SECRET read
// server-side. Delete after use.
const TOKEN = "b7d3f9a1c6e2508bad4c9b6e2f5a08d3c7b1e946";

const URLS = [
  "https://thermofisher.wd5.myworkdayjobs.com/ThermoFisherCareers/job/Budapest-Hungary/Accountant-I_R-01366406/apply",
  "https://thermofisher.wd5.myworkdayjobs.com/ThermoFisherCareers/job/Budapest-Hungary/Category-Manager---Site-Services_R-01367253/apply",
  "https://danaher.wd1.myworkdayjobs.com/DanaherJobs/job/Budapest-Hungary/FP-A-Senior-Business-Analyst_R1316235/apply",
  "https://danaher.wd1.myworkdayjobs.com/DanaherJobs/job/Budapest-Hungary/Finance-Systems-Manager_R1302309/apply",
];

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });

  const secret = process.env.AI_INGEST_TOKEN || process.env.CRON_SECRET;
  const siteUrl = process.env.URL;
  if (!secret || !siteUrl) return new Response("missing AI_INGEST_TOKEN/CRON_SECRET/URL", { status: 500 });

  const res = await fetch(`${siteUrl}/.netlify/functions/ats-tenants`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ urls: URLS }),
  });
  const text = await res.text();
  return new Response(JSON.stringify({ status: res.status, body: text }), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
};
