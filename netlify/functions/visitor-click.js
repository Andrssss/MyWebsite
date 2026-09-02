// netlify/functions/visitor-click.js
const { Pool } = require("pg");
const { withDbAuditFlush } = require("./_db_audit.js");
const { hasJobBoardAccess, adminKeys, matchesAny } = require("./_admin_identity_core");

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) {
  throw new Error("NETLIFY_DATABASE_URL environment variable is not set.");
}

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

const sql = { query: (text, params) => pool.query(text, params) };

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

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 30;
const clickHits = globalThis.__visitorClickHits || new Map();
globalThis.__visitorClickHits = clickHits;
const TARGET_DATE_SUFFIX_RE = /\s+\d{4}\.\s\d{2}\.\s\d{2}\.$/;

const ensureTable =
  globalThis.__ensureVisitorClickDatesTable ||
  sql.query(
    `CREATE TABLE IF NOT EXISTS visitor_click_dates (
       visitor_cookie text NOT NULL,
       clicked_on text NOT NULL,
       created_at timestamptz NOT NULL DEFAULT now()
     )`
  );
globalThis.__ensureVisitorClickDatesTable = ensureTable;

function normalizeTarget(target) {
  return String(target || "").replace(TARGET_DATE_SUFFIX_RE, "").trim();
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

exports.handler = withDbAuditFlush("visitor-click", async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(), body: "" };
  }

  // Click tracking only ever fires from /allasfigyelo and /allasfigyelo/stats,
  // both admin-only now — so an uncredentialed caller is by definition not the
  // page. Gating it also closes the write path (anyone could stuff the
  // analytics table before).
  if (!hasJobBoardAccess(event)) {
    return jsonResponse(401, { error: "Unauthorized" }, { "Cache-Control": "private, no-store" });
  }

  if (event.httpMethod === "GET") {
    if (event.queryStringParameters?.detail === "1") {
      const adminId = event.queryStringParameters?.adminId || "";
      if (!isAdminVisitor(adminId)) {
        return jsonResponse(403, { error: "Forbidden" });
      }
      try {
        await ensureTable;
        const { rows } = await sql.query(
          `SELECT visitor_cookie,
                  REGEXP_REPLACE(clicked_on, '\\s+\\d{4}\\.\\s\\d{2}\\.\\s\\d{2}\\.$', '') AS clicked_on,
                  created_at
           FROM visitor_click_dates
           WHERE visitor_cookie <> ALL($1::text[])
           ORDER BY created_at DESC
           LIMIT 2000`,
          [adminKeys()]
        );
        return jsonResponse(200, { rows });
      } catch (err) {
        console.error("[visitor-click] GET detail error:", err);
        return jsonResponse(500, { error: "Server error" });
      }
    }

    try {
      await ensureTable;
      const limit = Math.min(parseInt(event.queryStringParameters?.limit || "50", 10), 200);
      const { rows } = await sql.query(
        `SELECT clicked_on, COUNT(*)::int AS count
         FROM (
           SELECT DISTINCT
             lower(trim(visitor_cookie::text)) AS visitor_cookie,
             trim(regexp_replace(clicked_on, '\\s+[0-9]{4}\\.\\s*[0-9]{2}\\.\\s*[0-9]{2}\\.\\s*$', '')) AS clicked_on
           FROM visitor_click_dates
           WHERE visitor_cookie <> ALL($1::text[])
             AND clicked_on NOT LIKE 'applied:%'
         ) AS unique_pairs
         GROUP BY clicked_on
         ORDER BY count DESC
         LIMIT $2`,
        [adminKeys(), limit]
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

  if (!visitorId) return jsonResponse(400, { error: "visitorId is required" });
  if (!target) return jsonResponse(400, { error: "target is required" });
  if (visitorId.length > 128) return jsonResponse(400, { error: "visitorId too long" });
  if (target.length > 512) return jsonResponse(400, { error: "target too long" });

  if (isAdminVisitor(visitorId)) {
    return jsonResponse(200, { ok: true, skipped: true });
  }

  const retryAfter = checkRateLimit(visitorId);
  if (retryAfter > 0) {
    return jsonResponse(429, { error: "Too many requests" }, { "Retry-After": String(retryAfter) });
  }

  try {
    await ensureTable;
    await sql.query(
      `INSERT INTO visitor_click_dates (visitor_cookie, clicked_on, created_at)
       VALUES ($1, $2, now())`,
      [visitorId, target]
    );
    return jsonResponse(200, { ok: true });
  } catch (err) {
    console.error("[visitor-click] INSERT error:", err);
    return jsonResponse(500, { error: "Server error" });
  }
});
