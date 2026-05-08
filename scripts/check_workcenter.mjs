import https from "https";
import zlib from "zlib";

const url = "https://workcenter.hu/munka/junior-it-tamogato-2/";

const req = https.request(new URL(url), {
  headers: {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
    "Accept-Encoding": "gzip,deflate,br",
    "Accept-Language": "hu-HU,hu;q=0.9",
  }
}, (res) => {
  console.log("STATUS:", res.statusCode);
  console.log("FINAL-URL:", url);

  let stream = res;
  const enc = (res.headers["content-encoding"] || "").toLowerCase();
  if (enc.includes("gzip")) stream = res.pipe(zlib.createGunzip());
  else if (enc.includes("br")) stream = res.pipe(zlib.createBrotliDecompress());
  else if (enc.includes("deflate")) stream = res.pipe(zlib.createInflate());

  let body = "";
  stream.setEncoding("utf8");
  stream.on("data", c => body += c);
  stream.on("end", () => {
    const munkaLinks = body.split("href=").filter(s => s.includes("/munka/") || s.includes("job_listing")).slice(0, 5).map(s => s.substring(0, 100));
    console.log("munka links:", munkaLinks);
    console.log("has __NEXT_DATA__:", body.includes("__NEXT_DATA__"));
    console.log("has wp-content:", body.includes("wp-content"));
    console.log("body length:", body.length);

    // Look for job listing containers
    const hasJobListings = body.includes("job_listings") || body.includes("job-listing") || body.includes("jobs_list");
    console.log("has job listing containers:", hasJobListings);

    // Find script tags that load JS
    const scriptMatches = body.match(/<script[^>]+src=[^>]+>/g) || [];
    console.log("scripts:", scriptMatches.slice(0, 5));

    // Find job description text block
    const descIdx = body.indexOf('class="job_description');
    if (descIdx > -1) {
      const descEnd = body.indexOf("</div>", descIdx + 500);
      console.log("\n--- job_description ---\n", body.substring(descIdx, Math.min(descIdx + 2000, descEnd)));
    }

    // Look for experience-related patterns
    const expPatterns = [/\d[\d\-–]*\s*(\u00e9v|\u00e9ves)\s*(tapasztalat|munkatapasztalat)/gi,
      /tapasztalat[^.]{0,60}/gi, /p\u00e1lyakezd[^.]{0,40}/gi, /junior[^.]{0,40}/gi,
      /gyakornokok?\b[^.]{0,40}/gi, /friss\s*diplom[^.]{0,40}/gi];
    expPatterns.forEach(re => {
      const m = body.match(re);
      if (m) console.log("EXP MATCH:", m.slice(0, 3));
    });
  });
});
req.on("error", e => console.error("ERROR:", e.message));
req.end();
