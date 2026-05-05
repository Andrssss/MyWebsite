// netlify/functions/visitor-click.js
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

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 30;
const clickHits = globalThis.__visitorClickHits || new Map();
globalThis.__visitorClickHits = clickHits;
const targetDateSuffixRegex = /\s+\d{4}\.\s\d{2}\.\s\d{2}\.$/;
const clickDateRegex = /^\d{4}-\d{2}-\d{2}$/;
const clickDateColumnCache = globalThis.__visitorClickDateColumnCache || { checked: false, exists: false };
globalThis.__visitorClickDateColumnCache = clickDateColumnCache;

function normalizeTarget(target) {
  return String(target || "").replace(targetDateSuffixRegex, "").trim();
}

async function hasClickedDateColumn() {
  if (clickDateColumnCache.checked) return clickDateColumnCache.exists;
  try {
    const { rows } = await pool.query(
      `SELECT 1
       FROM information_schema.columns
       WHERE table_name = 'visitor_clicks' AND column_name = 'clicked_date'
       LIMIT 1`
    );
    clickDateColumnCache.exists = rows.length > 0;
  } catch {
    clickDateColumnCache.exists = false;
  } finally {
    clickDateColumnCache.checked = true;
  }
  return clickDateColumnCache.exists;
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

function checkRateLimit(visitorId) {
  const now = Date.now();
  const minTs = now - RATE_LIMIT_WINDOW_MS;
  const timestamps = (clickHits.get(visitorId) || []).filter((ts) => ts > minTs);
  timestamps.push(now);
  clickHits.set(visitorId, timestamps);

  if (clickHits.size > 3000) {
    for (const [id, tss] of clickHits.entries()) {
      const fresh = tss.filter((ts) => ts > minTs);
      if (fresh.length === 0) clickHits.delete(id);
      else clickHits.set(id, fresh);
    }
  }

  return timestamps.length > RATE_LIMIT_MAX
    ? Math.max(1, Math.ceil((timestamps[0] + RATE_LIMIT_WINDOW_MS - now) / 1000))
    : 0;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(), body: "" };
  }

  // GET: top clicked items (admin only or public stats)
  if (event.httpMethod === "GET") {
    try {
      const limit = Math.min(parseInt(event.queryStringParameters?.limit || "50", 10), 200);
      const { rows } = await pool.query(
        `SELECT clicked_on, COUNT(*)::int AS count
         FROM (
           SELECT DISTINCT
             lower(trim(visitor_cookie::text)) AS visitor_cookie,
             trim(regexp_replace(clicked_on, '\\s+[0-9]{4}\\.\\s*[0-9]{2}\\.\\s*[0-9]{2}\\.\\s*$', '')) AS clicked_on
           FROM visitor_clicks
           WHERE visitor_cookie NOT IN (SELECT unnest($1::text[]))
             AND clicked_on NOT LIKE 'applied:%'
         ) AS unique_pairs
         GROUP BY clicked_on
         ORDER BY count DESC
         LIMIT $2`,
        [[...ADMIN_VISITOR_IDS], limit]
      );
      return jsonResponse(200, { clicks: rows }, { "Cache-Control": "public, max-age=60" });
    } catch (err) {
      console.error("[visitor-click] GET error:", err);
      return jsonResponse(500, { error: "Server error" });
    }
  }

  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method not allowed" });
  }

  const MAX_BODY_BYTES = 2048;
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
  const target = normalizeTarget(payload.target);
  const clickedDate = String(payload.clickedDate || "").trim();

  if (!visitorId) return jsonResponse(400, { error: "visitorId is required" });
  if (!target) return jsonResponse(400, { error: "target is required" });
  if (visitorId.length > 128) return jsonResponse(400, { error: "visitorId too long" });
  if (target.length > 512) return jsonResponse(400, { error: "target too long" });
  if (clickedDate && !clickDateRegex.test(clickedDate)) {
    return jsonResponse(400, { error: "clickedDate must be YYYY-MM-DD" });
  }

  if (ADMIN_VISITOR_IDS.has(visitorId)) {
    return jsonResponse(200, { ok: true, skipped: true });
  }

  const retryAfter = checkRateLimit(visitorId);
  if (retryAfter > 0) {
    return jsonResponse(429, { error: "Too many requests" }, { "Retry-After": String(retryAfter) });
  }

  try {
    if (await hasClickedDateColumn()) {
      await pool.query(
        `INSERT INTO visitor_clicks (visitor_cookie, clicked_on, clicked_date) VALUES ($1, $2, $3)`,
        [visitorId, target, clickedDate || null]
      );
    } else {
      await pool.query(
        `INSERT INTO visitor_clicks (visitor_cookie, clicked_on) VALUES ($1, $2)`,
        [visitorId, target]
      );
    }
    return jsonResponse(200, { ok: true });
  } catch (err) {
    console.error("[visitor-click] INSERT error:", err);
    return jsonResponse(500, { error: "Server error" });
  }
};
