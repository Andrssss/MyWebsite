// ONE-OFF temporary reader for the audit-deactivations-background blob — delete
// together with that file after use.
const { getStore } = require("@netlify/blobs");

exports.handler = async (event) => {
  const auth = (event.headers && (event.headers.authorization || event.headers.Authorization)) || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  const expected = process.env.CRON_SECRET;
  if (!expected || token !== expected) {
    return { statusCode: 401, body: "Unauthorized" };
  }

  const store = getStore("job-audit");
  const data = await store.get("latest", { type: "json" }).catch(() => null);
  if (!data) {
    return { statusCode: 404, body: JSON.stringify({ status: "not_found" }) };
  }
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(data),
  };
};
