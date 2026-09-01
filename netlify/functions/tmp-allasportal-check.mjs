/* Disposable one-off check — DELETE after use.
   Confirms whether allasportal.hu still Cloudflare-blocks Netlify's datacenter IP
   (the scraper was shelved 2026-07-11 for exactly this reason; the parse/pagination
   side is done and re-verified live 2026-09-01 from a residential IP).
   Hardcoded token, not CRON_SECRET — read-only, no DB access, remove right after
   the answer is read. */

import https from "https";

const TOKEN = "a41f0c7b93e5426db8ec1f0aa7c25d3e6b9147f0c2ad58be";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

function check(url) {
  return new Promise((resolve) => {
    const req = https.request(
      url,
      {
        method: "GET",
        headers: {
          "User-Agent": UA,
          Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
          "Accept-Language": "hu-HU,hu;q=0.9,en;q=0.8",
        },
        timeout: 20000,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          const jobLinks = new Set(
            (body.match(/href="[^"]*(?:munka-[^"/]+\/|munka\/redirect\/\d+)"/g) || [])
          );
          resolve({
            url,
            status: res.statusCode,
            location: res.headers.location || null,
            server: res.headers.server || null,
            cfRay: res.headers["cf-ray"] || null,
            bytes: body.length,
            jobLinks: jobLinks.size,
            snippet: body.slice(0, 200).replace(/\s+/g, " "),
          });
        });
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

  const results = [];
  for (const u of [
    "https://allasportal.hu/v-budapest/k-informatika/",
    "https://allasportal.hu/v-budapest/k-informatika/?page=2",
    "https://allasportal.hu/munka-rendszeruzemelteto/",
  ]) {
    results.push(await check(u));
  }

  return new Response(JSON.stringify(results, null, 2), {
    headers: { "content-type": "application/json" },
  });
};
