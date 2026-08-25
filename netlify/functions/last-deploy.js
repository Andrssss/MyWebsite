const https = require("https");
const { hasJobBoardAccess } = require("./_admin_identity_core");

exports.handler = async (event = {}) => {
  // Only shown on the (now admin-only) /allasfigyelo page. Gated because the
  // response is derived from a Netlify API call made with CRON_SECRET — no
  // reason to hand deploy history to anyone who curls the URL.
  if (!hasJobBoardAccess(event)) {
    return {
      statusCode: 401,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, no-store" },
      body: JSON.stringify({ error: "Unauthorized" }),
    };
  }

  const token = process.env.CRON_SECRET;
  const siteId = process.env.SITE_ID;

  if (!token || !siteId) {
    return { statusCode: 500, body: JSON.stringify({ error: "Missing CRON_SECRET or SITE_ID" }) };
  }

  const data = await new Promise((resolve, reject) => {
    const options = {
      hostname: "api.netlify.com",
      path: `/api/v1/sites/${siteId}/deploys?per_page=100`,
      method: "GET",
      headers: {
        "User-Agent": "netlify-function",
        Authorization: `Bearer ${token}`,
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

  const deploys = Array.isArray(data) ? data : [];
  const latest = deploys
    .filter((d) => d?.context === "production" && d?.published_at)
    .sort((a, b) => new Date(b.published_at).getTime() - new Date(a.published_at).getTime())[0];

  if (!latest) {
    return { statusCode: 404, body: JSON.stringify({ error: "No production deploys found" }) };
  }

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ updates: [{ date: latest.published_at }] }),
  };
};
