/* Disposable one-off check — DELETE after use.
   Confirms whether workcenter.hu still WAF-blocks Netlify's datacenter IP
   (dropped 2026-07-08 for exactly this reason). Hardcoded token, not CRON_SECRET —
   read-only, no DB access, meant to be removed right after the answer is read. */

import https from "https";

const TOKEN = "60f61229dee7e999ab2872e9edb89d9fac65bd9a2be15cc9";

function check(url) {
  return new Promise((resolve) => {
    const req = https.request(
      url,
      {
        method: "GET",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          Accept: "application/json,text/html;q=0.9,*/*;q=0.8",
        },
        timeout: 15000,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ url, status: res.statusCode, snippet: body.slice(0, 200) }));
      }
    );
    req.on("timeout", () => { req.destroy(); resolve({ url, status: "TIMEOUT" }); });
    req.on("error", (err) => resolve({ url, status: "ERROR", message: err.message }));
    req.end();
  });
}

export default async (request) => {
  const auth = request.headers.get("authorization") || "";
  if (auth !== `Bearer ${TOKEN}`) return new Response("Unauthorized", { status: 401 });

  const results = await Promise.all([
    check("https://workcenter.hu/"),
    check("https://workcenter.hu/wp-json/wp/v2/job-listings?job-categories=755&per_page=5&page=1"),
    check("https://workcenter.hu/wp-json/wp/v2/job-categories?slug=informatikus"),
  ]);

  return new Response(JSON.stringify(results, null, 2), {
    headers: { "content-type": "application/json" },
  });
};
