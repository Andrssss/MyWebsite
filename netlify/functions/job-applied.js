// netlify/functions/job-applied.js
// Stores applied state in the existing visitor_clicks table using "applied:" prefix.
// apply  → INSERT INTO visitor_clicks (visitor_cookie, clicked_on) VALUES ($1, 'applied:' + jobKey)
// unapply → DELETE FROM visitor_clicks WHERE visitor_cookie=$1 AND clicked_on='applied:' + jobKey
const { Pool } = require("pg");

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) {
  throw new Error("NETLIFY_DATABASE_URL environment variable is not set.");
}

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "https://bakan7.netlify.app";
const APPLIED_PREFIX = "applied:";

function corsHeaders(extra = {}) {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    ...extra,
  };
}

function jsonResponse(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: corsHeaders(extraHeaders),
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(), body: "" };
  }

  // GET ?visitorId=xxx  → returns { applied: ['job:src:title', ...] }
  if (event.httpMethod === "GET") {
    const visitorId = String(event.queryStringParameters?.visitorId || "").trim();
    if (!visitorId) return jsonResponse(400, { error: "visitorId is required" });
    if (visitorId.length > 128) return jsonResponse(400, { error: "visitorId too long" });

    try {
      const { rows } = await pool.query(
        `SELECT DISTINCT clicked_on FROM visitor_clicks
         WHERE visitor_cookie = $1 AND clicked_on LIKE $2`,
        [visitorId, APPLIED_PREFIX + "%"]
      );
      const applied = rows.map((r) => r.clicked_on.slice(APPLIED_PREFIX.length));
      return jsonResponse(200, { applied });
    } catch (err) {
      console.error("[job-applied] GET error:", err);
      return jsonResponse(500, { error: "Server error" });
    }
  }

  // POST { visitorId, jobKey, applied: bool }
  if (event.httpMethod === "POST") {
    const MAX_BODY_BYTES = 1024;
    const rawBody = event.body || "";
    const bodyBytes = event.isBase64Encoded
      ? Math.floor((rawBody.length * 3) / 4)
      : Buffer.byteLength(rawBody, "utf8");
    if (bodyBytes > MAX_BODY_BYTES) {
      return jsonResponse(413, { error: "Payload too large" });
    }

    let payload;
    try {
      const decoded = event.isBase64Encoded
        ? Buffer.from(rawBody, "base64").toString("utf8")
        : rawBody;
      payload = JSON.parse(decoded || "{}");
    } catch {
      return jsonResponse(400, { error: "Invalid JSON body" });
    }

    const visitorId = String(payload.visitorId || "").trim();
    const jobKey = String(payload.jobKey || "").trim();
    const applied = Boolean(payload.applied);

    if (!visitorId) return jsonResponse(400, { error: "visitorId is required" });
    if (!jobKey) return jsonResponse(400, { error: "jobKey is required" });
    if (visitorId.length > 128) return jsonResponse(400, { error: "visitorId too long" });
    if (jobKey.length > 512) return jsonResponse(400, { error: "jobKey too long" });

    const clickedOn = APPLIED_PREFIX + jobKey;

    try {
      if (applied) {
        // INSERT only if not already present (idempotent)
        await pool.query(
          `INSERT INTO visitor_clicks (visitor_cookie, clicked_on)
           SELECT $1, $2
           WHERE NOT EXISTS (
             SELECT 1 FROM visitor_clicks WHERE visitor_cookie = $1 AND clicked_on = $2
           )`,
          [visitorId, clickedOn]
        );
      } else {
        await pool.query(
          `DELETE FROM visitor_clicks WHERE visitor_cookie = $1 AND clicked_on = $2`,
          [visitorId, clickedOn]
        );
      }
      return jsonResponse(200, { ok: true });
    } catch (err) {
      console.error("[job-applied] POST error:", err);
      return jsonResponse(500, { error: "Server error" });
    }
  }

  return jsonResponse(405, { error: "Method not allowed" });
};
