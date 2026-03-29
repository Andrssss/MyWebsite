const https = require("https");

exports.handler = async () => {
  const data = await new Promise((resolve, reject) => {
    const options = {
      hostname: "api.github.com",
      path: "/repos/Andrssss/MyWebsite/commits?per_page=3",
      method: "GET",
      headers: {
        "User-Agent": "netlify-function",
        Accept: "application/vnd.github+json",
      },
    };

    const req = https.request(options, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error("JSON parse error")); }
      });
    });

    req.on("error", reject);
    req.end();
  });

  const commits = Array.isArray(data) ? data : [];
  if (commits.length === 0) {
    return { statusCode: 404, body: JSON.stringify({ error: "No commits found" }) };
  }

  const updates = commits.slice(0, 3).map((commit) => ({
    message: String(commit?.commit?.message || "").split("\n")[0].trim(),
    date: commit?.commit?.author?.date || null,
  }));

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ updates }),
  };
};
