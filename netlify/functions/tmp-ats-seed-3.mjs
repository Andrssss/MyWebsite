// DISPOSABLE — 2026-09-15. Seeds the Husqvarna Workday tenant found during
// the ATS extension follow-up (confirmed live via the cxs jobs API: exactly
// 1 active Budapest posting today). Delete after use.
const TOKEN = "f4a8d2c6b1e93507ba6c1d8f4b0e93a7c2d8f651";

const URLS = [
  "https://husqvarnagroup.wd3.myworkdayjobs.com/External_Career_Site/job/Budapest/Aftersales-Specialist-Construction_R-14389",
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
