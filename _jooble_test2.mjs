import https from "https";

// Try Jooble's known internal API endpoint
function tryPost(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const opts = {
      hostname: "hu.jooble.org",
      path,
      method: "POST",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Accept-Language": "hu-HU,hu;q=0.9",
        "Content-Length": Buffer.byteLength(data),
      },
      timeout: 10000,
    };
    const req = https.request(opts, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve({ status: res.statusCode, body: d }));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.write(data);
    req.end();
  });
}

function tryGet(path) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: "hu.jooble.org",
      path,
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json, text/html",
        "Accept-Language": "hu-HU,hu;q=0.9",
      },
      timeout: 10000,
    };
    const req = https.request(opts, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve({ status: res.statusCode, body: d, headers: res.headers }));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.end();
  });
}

async function main() {
  // 1) Try known partner API
  const endpoints = [
    { method: "POST", path: "/api/serp", body: { keywords: "programozó", location: "Budapest" } },
    { method: "POST", path: "/api/serp/search", body: { keywords: "programozó", location: "Budapest" } },
    { method: "GET", path: "/api/serp?q=programoz%C3%B3&rgns=Budapest" },
    { method: "GET", path: "/SearchResult?rgns=Budapest&ukw=programoz%C3%B3", headers: { "X-Requested-With": "XMLHttpRequest" } },
  ];

  for (const ep of endpoints) {
    try {
      console.log(`\n--- ${ep.method} ${ep.path} ---`);
      let res;
      if (ep.method === "POST") {
        res = await tryPost(ep.path, ep.body);
      } else {
        res = await tryGet(ep.path);
      }
      console.log("status:", res.status);
      console.log("body preview:", res.body.substring(0, 500));
      if (res.body.startsWith("{") || res.body.startsWith("[")) {
        try {
          const json = JSON.parse(res.body);
          console.log("JSON keys:", Object.keys(json));
          if (json.jobs) console.log("jobs count:", json.jobs.length, "first:", JSON.stringify(json.jobs[0]).substring(0, 300));
          if (json.totalCount) console.log("totalCount:", json.totalCount);
        } catch {}
      }
    } catch (e) {
      console.log("error:", e.message);
    }
  }
}

main();
