import https from "https";
import zlib from "zlib";

function request(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "hu",
        "Accept-Encoding": "gzip, deflate",
      },
      timeout: 15000,
    };
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        const enc = res.headers["content-encoding"];
        let body;
        if (enc === "gzip") body = zlib.gunzipSync(buf).toString();
        else if (enc === "deflate") body = zlib.inflateSync(buf).toString();
        else body = buf.toString();
        resolve({ status: res.statusCode, body, headers: res.headers });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.end();
  });
}

async function main() {
  // Try as Googlebot
  console.log("=== Googlebot UA ===");
  const r1 = await request("https://hu.jooble.org/SearchResult?rgns=Budapest&ukw=programoz%C3%B3");
  console.log("status:", r1.status, "len:", r1.body.length);
  const jdp1 = (r1.body.match(/\/jdp\//g) || []).length;
  console.log("jdp links:", jdp1);
  if (jdp1 === 0) console.log("body preview:", r1.body.substring(0, 300));

  // Try the official Jooble API for developers
  // https://jooble.org/api/about - They provide a free API
  console.log("\n=== Jooble public API (no key) ===");
  const apiBody = JSON.stringify({ keywords: "programozó", location: "Budapest" });
  const r2 = await new Promise((resolve, reject) => {
    const opts = {
      hostname: "hu.jooble.org",
      path: "/api/",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(apiBody),
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
    req.write(apiBody);
    req.end();
  });
  console.log("status:", r2.status);
  console.log("body:", r2.body.substring(0, 500));

  // Try jooble.org (not hu.) API
  console.log("\n=== jooble.org/api/ ===");
  const r3 = await new Promise((resolve, reject) => {
    const opts = {
      hostname: "jooble.org",
      path: "/api/",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(apiBody),
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
    req.write(apiBody);
    req.end();
  });
  console.log("status:", r3.status);
  console.log("body:", r3.body.substring(0, 500));

  // Try RSS
  console.log("\n=== RSS feed ===");
  try {
    const r4 = await request("https://hu.jooble.org/rss?ukw=programoz%C3%B3&rgns=Budapest");
    console.log("status:", r4.status);
    console.log("body:", r4.body.substring(0, 500));
  } catch(e) { console.log("error:", e.message); }

  // Try feed URL
  console.log("\n=== /feed ===");
  try {
    const r5 = await request("https://hu.jooble.org/feed?ukw=programoz%C3%B3&rgns=Budapest");
    console.log("status:", r5.status);
    console.log("body:", r5.body.substring(0, 500));
  } catch(e) { console.log("error:", e.message); }
}

main().catch(console.error);
