// netlify/functions/daily-visitor.js
const { Pool } = require("pg");

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) {
  console.error("❌ NETLIFY_DATABASE_URL nincs beállítva.");
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
]);

const VISITOR_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const VISITOR_RATE_LIMIT_MAX_REQUESTS = 10;
const visitorHits = globalThis.__dailyVisitorHits || new Map();
globalThis.__dailyVisitorHits = visitorHits;

let schemaReady = false;
async function ensureSchema() {
  if (schemaReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS daily_visitors (
      visit_date DATE NOT NULL,
      visitor_cookie TEXT NOT NULL,
      visitor_type TEXT NOT NULL DEFAULT 'user',
      PRIMARY KEY (visit_date, visitor_cookie)
    )
  `);
  await pool.query(
    `ALTER TABLE daily_visitors
     ADD COLUMN IF NOT EXISTS visitor_type TEXT NOT NULL DEFAULT 'user'`
  );
  schemaReady = true;
}

function getVisitorType(visitorId) {
  return ADMIN_VISITOR_IDS.has(visitorId) ? "admin" : "user";
}

function cleanupOldVisitorHits(now) {
  const minTs = now - VISITOR_RATE_LIMIT_WINDOW_MS;
  for (const [visitorId, timestamps] of visitorHits.entries()) {
    const fresh = timestamps.filter((ts) => ts > minTs);
    if (fresh.length === 0) visitorHits.delete(visitorId);
    else visitorHits.set(visitorId, fresh);
  }
}

function checkVisitorRateLimit(visitorId) {
  const now = Date.now();
  const minTs = now - VISITOR_RATE_LIMIT_WINDOW_MS;
  const timestamps = (visitorHits.get(visitorId) || []).filter((ts) => ts > minTs);
  timestamps.push(now);
  visitorHits.set(visitorId, timestamps);

  if (visitorHits.size > 3000) cleanupOldVisitorHits(now);

  if (timestamps.length > VISITOR_RATE_LIMIT_MAX_REQUESTS) {
    return Math.max(
      1,
      Math.ceil((timestamps[0] + VISITOR_RATE_LIMIT_WINDOW_MS - now) / 1000)
    );
  }
  return 0;
}

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

  try {
    await ensureSchema();
  } catch (err) {
    console.error("[daily-visitor] schema error:", err);
    return jsonResponse(500, { error: "Server error" });
  }

  if (event.httpMethod === "GET") {
    try {
      const { rows } = await pool.query(
        `SELECT COUNT(DISTINCT visitor_cookie)::int AS wau
         FROM daily_visitors
         WHERE visit_date >= CURRENT_DATE - 6
           AND visitor_type = 'user'`
      );
      return jsonResponse(
        200,
        { wau: rows[0]?.wau ?? 0 },
        { "Cache-Control": "public, max-age=300" }
      );
    } catch (err) {
      console.error("[daily-visitor] WAU error:", err);
      return jsonResponse(500, { error: "Server error" });
    }
  }

  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method not allowed" });
  }

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
  if (!visitorId) return jsonResponse(400, { error: "visitorId is required" });
  if (visitorId.length > 128) return jsonResponse(400, { error: "visitorId is too long" });

  const retryAfter = checkVisitorRateLimit(visitorId);
  if (retryAfter > 0) {
    return jsonResponse(
      429,
      { error: "Too many requests for this visitor. Try again later." },
      { "Retry-After": String(retryAfter) }
    );
  }

  try {
    const visitorType = getVisitorType(visitorId);
    const { rowCount } = await pool.query(
      `INSERT INTO daily_visitors (visit_date, visitor_cookie, visitor_type)
       VALUES (CURRENT_DATE, $1, $2)
       ON CONFLICT (visit_date, visitor_cookie) DO NOTHING`,
      [visitorId, visitorType]
    );
    return jsonResponse(200, {
      ok: true,
      inserted: rowCount > 0,
      visitorType,
      visitDate: new Date().toISOString().slice(0, 10),
    });
  } catch (err) {
    console.error("[daily-visitor] Error:", err);
    return jsonResponse(500, { error: "Server error" });
  }
};
