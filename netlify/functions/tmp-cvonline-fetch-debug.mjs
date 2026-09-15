// DISPOSABLE — 2026-09-15. Debug: what does cvonline.hu actually return when
// fetched from Netlify's own function runtime (egress IP), vs a home
// connection where the same fetch() call returns full job listings? Delete
// after use.
const TOKEN = "c2f8a1e5b9d34706ec5a8b1d4f7092e3c6b9d158";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });

  const res = await fetch("https://www.cvonline.hu/hu/allashirdetesek/it-informatika-0", {
    headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
    signal: AbortSignal.timeout(25000),
  });
  const text = await res.text();
  return new Response(
    JSON.stringify({
      status: res.status,
      finalUrl: res.url,
      length: text.length,
      hasMarker: text.includes("node--job-per-template"),
      snippet: text.slice(0, 1500),
    }),
    { headers: { "content-type": "application/json; charset=utf-8" } }
  );
};
