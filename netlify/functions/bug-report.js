// netlify/functions/bug-report.js
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

const ADMIN_VISITOR_IDS = new Set([
  "43e878e0-f5fd-45f3-bfd4-9473e5deec11",
  "69872482-1311-4702-a5e5-a782ca9f2669",
  "82906f93-dfbb-4684-b2b1-a948b99553e0",
  "b878ceed-55b7-47db-87ec-c4e2825246f8",
]);

const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const RATE_LIMIT_MAX = 1;

const bugHits = globalThis.__bugReportHits || new Map();
globalThis.__bugReportHits = bugHits;

const ensureBugReportsTablePromise =
  globalThis.__ensureBugReportsTablePromise ||
  pool.query(
    `CREATE TABLE IF NOT EXISTS bug_reports (
       id serial PRIMARY KEY,
       message text NOT NULL,
       created_at timestamptz NOT NULL DEFAULT now()
     )`
  );

globalThis.__ensureBugReportsTablePromise = ensureBugReportsTablePromise;

function corsHeaders(extra = {}) {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
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

function getClientIp(event) {
  const headers = event.headers || {};
  const forwardedFor = headers["x-forwarded-for"] || headers["X-Forwarded-For"] || "";
  const netlifyIp = headers["x-nf-client-connection-ip"] || headers["X-Nf-Client-Connection-Ip"] || "";
  const clientIp = headers["client-ip"] || headers["Client-Ip"] || "";

  return forwardedFor.split(",")[0].trim() || netlifyIp.trim() || clientIp.trim() || "unknown";
}

function getRateLimitKey(event, visitorId) {
  const ip = getClientIp(event);
  if (ip && ip !== "unknown") return `ip:${ip}`;
  if (visitorId) return `visitor:${visitorId}`;
  return null;
}

function checkRateLimit(rateLimitKey) {
  if (!rateLimitKey) return 0;

  const now = Date.now();
  const minTs = now - RATE_LIMIT_WINDOW_MS;
  const timestamps = (bugHits.get(rateLimitKey) || []).filter((ts) => ts > minTs);
  timestamps.push(now);
  bugHits.set(rateLimitKey, timestamps);

  if (bugHits.size > 1000) {
    for (const [key, values] of bugHits.entries()) {
      if (values.filter((ts) => ts > minTs).length === 0) bugHits.delete(key);
    }
  }

  if (timestamps.length > RATE_LIMIT_MAX) {
    return Math.max(1, Math.ceil((timestamps[0] + RATE_LIMIT_WINDOW_MS - now) / 1000));
  }
  return 0;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(), body: "" };
  }

  if (event.httpMethod === "GET") {
    const adminId = event.queryStringParameters?.adminId || "";
    if (!ADMIN_VISITOR_IDS.has(adminId)) {
      return jsonResponse(403, { error: "Forbidden" });
    }
    try {
      await ensureBugReportsTablePromise;
      const result = await pool.query(
        `SELECT id, message, created_at FROM bug_reports ORDER BY created_at DESC LIMIT 500`
      );
      return jsonResponse(200, { reports: result.rows });
    } catch (err) {
      console.error("[bug-report] GET error:", err);
      return jsonResponse(500, { error: "Server error" });
    }
  }

  if (event.httpMethod === "DELETE") {
    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return jsonResponse(400, { error: "Invalid JSON" });
    }
    const adminId = String(body.adminId || "");
    if (!ADMIN_VISITOR_IDS.has(adminId)) {
      return jsonResponse(403, { error: "Forbidden" });
    }
    const id = parseInt(body.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return jsonResponse(400, { error: "Invalid id" });
    }
    try {
      await ensureBugReportsTablePromise;
      await pool.query(`DELETE FROM bug_reports WHERE id = $1`, [id]);
      return jsonResponse(200, { ok: true });
    } catch (err) {
      console.error("[bug-report] DELETE error:", err);
      return jsonResponse(500, { error: "Server error" });
    }
  }

  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method not allowed" });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return jsonResponse(400, { error: "Invalid JSON" });
  }

  const visitorId = String(body.visitorId || "").trim();
  if (visitorId.length > 128) {
    return jsonResponse(400, { error: "visitorId too long" });
  }

  const retryAfter = checkRateLimit(getRateLimitKey(event, visitorId));
  if (retryAfter > 0) {
    return jsonResponse(429, { error: "Too many requests" }, { "Retry-After": String(retryAfter) });
  }

  const message = (body.message || "").trim().slice(0, 2000);
  if (typeof body.message !== "string" || !message) {
    return jsonResponse(400, { error: "Message is required" });
  }

  const sanitized = message
    .replace(/\x00/g, "")
    .replace(/[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
  if (!sanitized) {
    return jsonResponse(400, { error: "Message is required" });
  }

  try {
    await ensureBugReportsTablePromise;
    await pool.query(`INSERT INTO bug_reports (message) VALUES ($1)`, [sanitized]);
    return jsonResponse(200, { ok: true });
  } catch (err) {
    console.error("[bug-report] POST error:", err);
    return jsonResponse(500, { error: "Server error" });
  }
};