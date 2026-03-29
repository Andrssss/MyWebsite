import https from "https";

const url = "https://hu.jooble.org/SearchResult?rgns=Budapest&ukw=programoz%C3%B3";
const opts = {
  headers: {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "text/html,application/xhtml+xml",
    "Accept-Language": "hu-HU,hu;q=0.9",
  },
};

https.get(url, opts, (res) => {
  let d = "";
  res.on("data", (c) => (d += c));
  res.on("end", () => {
    console.log("status:", res.statusCode);
    console.log("len:", d.length);

    // Check for job links
    const jdpCount = (d.match(/\/jdp\//g) || []).length;
    const descCount = (d.match(/\/desc\//g) || []).length;
    console.log("jdp links:", jdpCount, "desc links:", descCount);

    // Check for SSR state
    console.log("__NEXT_DATA__:", d.includes("__NEXT_DATA__"));
    console.log("__NUXT__:", d.includes("__NUXT__"));

    // Check for window state vars
    const stateVars = d.match(/window\.__[A-Z_]+\s*=/g);
    if (stateVars) console.log("window state vars:", stateVars);

    // Look for API URLs in scripts
    const apiUrls = d.match(/["'](\/api\/[^"']+)["']/g);
    if (apiUrls) console.log("API URLs:", apiUrls.slice(0, 10));

    // Look for fetch/xhr patterns
    const fetchPatterns = d.match(/fetch\(["'][^"']+["']/g);
    if (fetchPatterns) console.log("fetch calls:", fetchPatterns.slice(0, 5));

    // Show interesting script snippets
    const scripts = [...d.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
    console.log("\ntotal scripts:", scripts.length);
    scripts.forEach((m, i) => {
      const body = m[1].trim();
      if (body.length > 50 && body.length < 5000) {
        console.log(`\n--- script ${i} (${body.length} chars) ---`);
        console.log(body.substring(0, 500));
      }
    });

    // Check if there is an embedded JSON blob
    const jsonBlob = d.match(/application\/json[^>]*>([\s\S]{100,}?)<\/script>/);
    if (jsonBlob) {
      console.log("\n--- JSON blob ---");
      console.log(jsonBlob[1].substring(0, 500));
    }

    // First 3000 chars of body
    const bodyStart = d.indexOf("<body");
    if (bodyStart > -1) {
      console.log("\n--- body start (1500 chars) ---");
      console.log(d.substring(bodyStart, bodyStart + 1500));
    }
  });
});
