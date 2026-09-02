// netlify/functions/daily-visitor.js
const { Pool } = require("pg");
const { withDbAuditFlush } = require("./_db_audit.js");

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) {
  console.error("❌ NETLIFY_DATABASE_URL nincs beállítva.");
  throw new Error("NETLIFY_DATABASE_URL environment variable is not set.");
}

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

const { adminKeys, matchesAny } = require("./_admin_identity_core");

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "https://bakan7.netlify.app";

// Admin visitor UUIDs come from the ADMIN_* env vars via _admin_identity_core —
// they used to be a hardcoded Set right here, which meant this public repo WAS
// the credential (2026-09-01: Netlify's secrets scanner failed the build over
// exactly these four literals, which is the correct verdict). adminKeys() re-reads
// process.env per call, so adding a device stays an env-only change, and the
// comparison is the same timing-safe, case-insensitive one the rest of the site uses.
function isAdminVisitor(id) {
  return matchesAny(id, adminKeys());
}

const VISITOR_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const VISITOR_RATE_LIMIT_MAX_REQUESTS = 10;
const visitorHits = globalThis.__dailyVisitorHits || new Map();
globalThis.__dailyVisitorHits = visitorHits;

function getVisitorType(visitorId) {
  return isAdminVisitor(visitorId) ? "admin" : "user";
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

exports.handler = withDbAuditFlush("daily-visitor", async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(), body: "" };
  }

  if (event.httpMethod === "GET") {
    // daily_visitors is now one row per visitor_cookie, ever (visit_date/
    // visitor_type were dropped, shared with pisiseknek_weblap): created_at
    // is the first visit, last_visited_at updates on every repeat one. A
    // returning visitor is one where those two have diverged (visited more
    // than once) and the latest visit falls inside the window.
    try {
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS mau
         FROM daily_visitors
         WHERE last_visited_at > created_at
           AND last_visited_at >= CURRENT_DATE - 29`
      );
      return jsonResponse(
        200,
        { mau: rows[0]?.mau ?? 0 },
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

    // Admin ne kerüljön a daily_visitors táblába egyáltalán — a saját
    // látogatásai ne torzítsák a naplózott sorokat (visitor_type már nincs
    // az adattáblában, ez a kizárás az egyetlen admin-mentesítés).
    if (visitorType === "admin") {
      return jsonResponse(200, {
        ok: true,
        inserted: false,
        visitorType,
      });
    }

    const rawOrigin = (event.headers?.origin || event.headers?.referer || "").trim();
    let site = null;
    try {
      if (rawOrigin) site = new URL(rawOrigin).hostname;
    } catch {
      // ignore malformed
    }
    const { rowCount } = await pool.query(
      `INSERT INTO daily_visitors (visitor_cookie, site)
       VALUES ($1, $2)
       ON CONFLICT (visitor_cookie) DO UPDATE SET last_visited_at = NOW()`,
      [visitorId, site]
    );
    return jsonResponse(200, {
      ok: true,
      inserted: rowCount > 0,
      visitorType,
    });
  } catch (err) {
    console.error("[daily-visitor] Error:", err);
    return jsonResponse(500, { error: "Server error" });
  }
});
