import https from "https";
import zlib from "zlib";
const url = "https://www.wherewework.hu/en/jobs/budaors,budapest/bpo-services,health-services,other-services,others,pharmaceutical,horeca,itc,trade,agriculture,education";
const u = new URL(url);
const req = https.request(u, { 
  method: "GET", 
  headers: { 
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36", 
    "Accept": "text/html", 
    "Accept-Encoding": "gzip,deflate" 
  } 
}, res => {
  let stream = res;
  if (res.headers["content-encoding"] === "gzip") stream = res.pipe(zlib.createGunzip());
  else if (res.headers["content-encoding"] === "deflate") stream = res.pipe(zlib.createInflate());
  let data = "";
  stream.setEncoding("utf8");
  stream.on("data", c => data += c);
  stream.on("end", () => {
    console.log("Total length:", data.length);
    const matches = data.match(/href="\/en\/jobs\/[^"]+\/\d+"/g);
    console.log("Job links found:", matches ? matches.length : 0);
    if (matches) {
       console.log("First 3:", matches.slice(0,3).join("\n"));
    } else {
       console.log("No matches. Searching for 'jobs' keyword index:", data.indexOf("jobs"));
       console.log("HTML Sample (500-1500 chars):", data.slice(500, 1500));
    }
  });
});
req.on("error", (e) => console.error(e));
req.end();
