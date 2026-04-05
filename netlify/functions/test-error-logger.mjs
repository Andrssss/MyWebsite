import { logFetchError } from "./_error-logger.mjs";
import https from "https";

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(u, { method: "GET", timeout: 10000 }, (res) => {
      const code = res.statusCode || 0;
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (code >= 200 && code < 300) resolve(data);
        else reject(new Error(`HTTP ${code} for ${url}`));
      });
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error(`Timeout for ${url}`)));
    req.on("error", reject);
    req.end();
  });
}

const TEST_URLS = [
  "https://httpstat.us/403",
  "https://httpstat.us/500",
  "https://httpstat.us/404",
  "https://this-domain-does-not-exist-xyz123.com/jobs",
];

export default async () => {
  const results = [];

  for (const url of TEST_URLS) {
    try {
      await fetchText(url);
      results.push({ url, ok: true });
    } catch (err) {
      await logFetchError("test_error_logger", { url, message: err.message });
      results.push({ url, ok: false, error: err.message });
    }
  }

  console.log("Test results:", JSON.stringify(results, null, 2));
  return new Response(JSON.stringify(results, null, 2), {
    headers: { "Content-Type": "application/json" },
  });
};
