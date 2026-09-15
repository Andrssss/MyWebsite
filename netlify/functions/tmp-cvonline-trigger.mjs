// DISPOSABLE — 2026-09-15. Smoke-test trigger for the new
// cron_jobs_CVONLINE-background.mjs scraper: forwards to it using the real
// CRON_SECRET (read server-side, never exposed to the caller). Delete after use.
const TOKEN = "d9e4b7a2c5f18306e9b4a7c2d5f9083b6a1e4c78";

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });

  const secret = process.env.CRON_SECRET;
  const siteUrl = process.env.URL;
  if (!secret || !siteUrl) return new Response("missing CRON_SECRET/URL", { status: 500 });

  const res = await fetch(`${siteUrl}/.netlify/functions/cron_jobs_CVONLINE-background`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}` },
  });
  const text = await res.text();
  return new Response(JSON.stringify({ status: res.status, body: text.slice(0, 500) }), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
};
