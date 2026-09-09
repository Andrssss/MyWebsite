// DISPOSABLE diagnostic — 2026-09-09. Checks whether joinus.hu blocks
// Netlify's outbound IPs (404 from Netlify infra, 200 from elsewhere).
// Delete after use.
import http from "http";
import https from "https";

const TOKEN = "763f13e6df929c214d0fdd59a54d83098c16151213335d01";
const REQUEST_TIMEOUT_MS = 15000;

function fetchOnce(url) {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === "https:" ? https : http;
    const req = lib.request(parsed, {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/json,*/*;q=0.8",
        "Accept-Language": "hu-HU,hu;q=0.9,en;q=0.8",
        "Accept-Encoding": "identity",
      },
      timeout: REQUEST_TIMEOUT_MS,
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { if (body.length < 5000) body += c; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, snippet: body.slice(0, 500) }));
    });
    req.on("timeout", () => { req.destroy(); resolve({ status: -2 }); });
    req.on("error", (e) => resolve({ status: -3, error: String(e) }));
    req.end();
  });
}

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });
  const url = "https://joinus.hu/xil-szimulacios-gyakornok-375a-9824-17af-d9da";
  const results = [];
  for (let i = 0; i < 4; i++) {
    results.push(await fetchOnce(url));
  }
  return new Response(JSON.stringify(results, null, 2), { headers: { "content-type": "application/json" } });
};
