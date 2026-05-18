const https = require("https");
const zlib = require("zlib");
const url = "https://www.wherewework.hu/en/jobs/budaors,budapest/bpo-services,health-services,other-services,others,pharmaceutical,horeca,itc,trade,agriculture,education";
const u = new URL(url);
const req = https.request(u, { method: "GET", headers: { "User-Agent": "JobWatcher/1.0", "Accept": "text/html", "Accept-Encoding": "gzip,deflate" } }, res => {
  let stream = res;
  if (res.headers["content-encoding"] === "gzip") stream = res.pipe(zlib.createGunzip());
  let data = "";
  stream.setEncoding("utf8");
  stream.on("data", c => data += c);
  stream.on("end", () => {
    const matches = data.match(/href="\/en\/jobs\/[^"]+\/\d+"/g);
    console.log("Job links found:", matches ? matches.length : 0);
    if (matches) console.log("First 3:", matches.slice(0,3).join("\n"));
    else console.log("No job links. HTML snippet:", data.slice(0, 500));
  });
});
req.on("error", (e) => console.error(e));
req.end();
