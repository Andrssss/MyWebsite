import https from "https";
import { URL } from "url";

function request(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const reqOpts = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: opts.method || "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Accept": opts.accept || "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "hu-HU,hu;q=0.9,en;q=0.8",
        "Accept-Encoding": "identity",
        ...(opts.headers || {}),
      },
      timeout: 15000,
    };
    if (opts.body) {
      reqOpts.headers["Content-Type"] = "application/json";
      reqOpts.headers["Content-Length"] = Buffer.byteLength(opts.body);
    }
    const req = https.request(reqOpts, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve({ status: res.statusCode, body: d, headers: res.headers }));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function main() {
  // Step 1: GET the search page to collect cookies
  console.log("Step 1: GET search page...");
  const page = await request("https://hu.jooble.org/SearchResult?rgns=Budapest&ukw=programoz%C3%B3");
  console.log("status:", page.status);
  console.log("body length:", page.body.length);

  // Collect set-cookie
  const cookies = page.headers["set-cookie"];
  console.log("cookies:", cookies);
  const cookieStr = cookies ? cookies.map(c => c.split(";")[0]).join("; ") : "";
  console.log("cookie string:", cookieStr);

  // Look for CSRF token or session data in HTML
  const csrfMatch = page.body.match(/csrf[^"']*["']([^"']+)["']/i);
  if (csrfMatch) console.log("CSRF:", csrfMatch[0]);

  const tokenMatch = page.body.match(/token[^"']*["']([^"']+)["']/i);
  if (tokenMatch) console.log("token:", tokenMatch[0]);

  // Look for __INITIAL_STATE__ or similar
  const stateMatch = page.body.match(/window\.\w+\s*=\s*(\{[\s\S]{0,2000}?\});/);
  if (stateMatch) {
    console.log("\nwindow state (first 500):", stateMatch[0].substring(0, 500));
  }

  // Check for embedded JSON in script type="application/json"
  const jsonScripts = [...page.body.matchAll(/<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/g)];
  console.log("\nJSON scripts found:", jsonScripts.length);
  jsonScripts.forEach((m, i) => {
    console.log(`json script ${i} (${m[1].length} chars):`, m[1].substring(0, 300));
  });

  // Check for embedded job data in HTML
  const jobCardCount = (page.body.match(/data-vacancy/g) || []).length;
  const articleCount = (page.body.match(/<article/g) || []).length;
  const serpItem = (page.body.match(/serp-item|SerpItem|vacancy|JobCard/gi) || []).length;
  console.log("\ndata-vacancy:", jobCardCount, "articles:", articleCount, "serp items:", serpItem);

  // Look for job links in HTML
  const jdpLinks = [...page.body.matchAll(/href="(\/jdp\/[^"]+)"/g)];
  const descLinks = [...page.body.matchAll(/href="(\/desc\/[^"]+)"/g)];
  console.log("jdp links:", jdpLinks.length, "desc links:", descLinks.length);
  if (jdpLinks.length > 0) console.log("first jdp:", jdpLinks[0][1].substring(0, 100));

  // Look for job titles in the HTML
  const titleMatches = [...page.body.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/g)];
  console.log("\nh2 tags:", titleMatches.length);
  titleMatches.slice(0, 5).forEach((m, i) => console.log(`  h2[${i}]:`, m[1].substring(0, 100)));

  // Try the API with cookies
  console.log("\n\nStep 2: POST /api/serp with cookies...");
  const apiBody = JSON.stringify({
    keywords: "programozó",
    location: "Budapest",
    page: 1,
  });
  try {
    const api = await request("https://hu.jooble.org/api/serp", {
      method: "POST",
      body: apiBody,
      accept: "application/json",
      headers: {
        Cookie: cookieStr,
        Referer: "https://hu.jooble.org/SearchResult?rgns=Budapest&ukw=programoz%C3%B3",
        Origin: "https://hu.jooble.org",
      },
    });
    console.log("API status:", api.status);
    console.log("API body preview:", api.body.substring(0, 1000));
    if (api.body.startsWith("{")) {
      const json = JSON.parse(api.body);
      console.log("JSON keys:", Object.keys(json));
      if (json.jobs) console.log("jobs count:", json.jobs.length);
      if (json.totalCount) console.log("totalCount:", json.totalCount);
    }
  } catch (e) {
    console.log("API error:", e.message);
  }
}

main().catch(console.error);
