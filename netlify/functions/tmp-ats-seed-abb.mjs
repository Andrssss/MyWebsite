// DISPOSABLE — 2026-09-15. Seeds the real ABB Workday tenant (confirmed live:
// abb.wd3:External_Career_Page, active Budapest postings incl. an intern
// program) into ats-tenants via the real production endpoint, using the real
// AI_INGEST_TOKEN/CRON_SECRET read server-side. Delete after use.
const TOKEN = "e5a9c2f7b1d84603ae7c1b5d8f2093a6c4b7e910";

const ABB_URLS = [
  "https://abb.wd3.myworkdayjobs.com/External_Career_Page/job/Budapest-Budapest-Hungary/ABB-Ni-Mentorprogram_JR00023389-1/apply",
  "https://abb.wd3.myworkdayjobs.com/External_Career_Page/job/Budapest-Budapest-Hungary/Szerviz-rtkest-mrnk_JR00029313/apply",
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
    body: JSON.stringify({ urls: ABB_URLS }),
  });
  const text = await res.text();
  return new Response(JSON.stringify({ status: res.status, body: text }), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
};
