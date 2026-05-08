import https from "https";
import zlib from "zlib";
import { load as cheerioLoad } from "cheerio";
import { extractYearsFromText } from "../netlify/functions/_experience_core.mjs";

const BASE = "https://workcenter.hu";
const url = "https://workcenter.hu/munka/support-mernok/";

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

    const $ = cheerioLoad(body);
    const descText = $(".single-job-listing__description").first().text();
    console.log("descText snippet:", descText.substring(0, 200));
    console.log("extractYearsFromText:", extractYearsFromText(descText));
  });
});
req.on("error", e => console.error("ERROR:", e.message));
req.end();
