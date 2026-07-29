// netlify/functions/job-hidden.js
//
// Standalone hide/unhide for a single job_posts row.
//
// `hidden` used to also be a SIDE EFFECT of marking a job applied
// (job-applied.js mirrored applied → hidden), but that mirroring was removed
// 2026-07-29 — applying to a job must not hide it from the public board.
// This endpoint is now the only way to hide/unhide: bury a posting you don't
// want on the board without claiming you applied to it.
//
// Auth = ADMIN_SECRET (the WRITE tier), deliberately NOT the LITTLE_ADMIN
// cookie: that one is read-only by design, so a leaked LITTLE_ADMIN can never
// be used to mass-hide the board. See the admin-credentials note in CLAUDE.md.
//
//   POST { url, hidden: true|false, source? }
//   Header: Authorization: Bearer $ADMIN_SECRET
const { Pool } = require("pg");
const { withDbAuditFlush } = require("./_db_audit.js");
const { bumpJobsCacheGeneration } = require("./_jobs_cache_core");

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) {
  throw new Error("NETLIFY_DATABASE_URL environment variable is not set.");
}

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "https://bakan7.netlify.app";

function authorized(event) {
  // Trimmed: see filters.js — a pasted trailing newline would silently reject all.
  const expected = (process.env.ADMIN_SECRET || process.env.CRON_SECRET || "").trim();
  if (!expected) return false;
  const hdr =
    (event.headers && (event.headers.authorization || event.headers.Authorization)) || "";
  const token = hdr.replace(/^Bearer\s+/i, "").trim();
  return token.length > 0 && token === expected;
}

function corsHeaders(extra = {}) {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    ...extra,
  };
}

function jsonResponse(statusCode, body) {
  return { statusCode, headers: corsHeaders(), body: JSON.stringify(body) };
}

exports.handler = withDbAuditFlush("job-hidden", async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(), body: "" };
  }
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method not allowed" });
  }
  if (!authorized(event)) return jsonResponse(401, { error: "Unauthorized" });

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return jsonResponse(400, { error: "Invalid JSON body" });
  }

  const url = typeof payload.url === "string" ? payload.url.trim() : "";
  const source = typeof payload.source === "string" ? payload.source.trim() : "";
  if (!url) return jsonResponse(400, { error: "url kötelező." });
  if (url.length > 2048) return jsonResponse(400, { error: "url túl hosszú." });
  if (typeof payload.hidden !== "boolean") {
    return jsonResponse(400, { error: "hidden (boolean) kötelező." });
  }
  const hidden = payload.hidden;

  try {
    // `url` alone is not a unique key — (source, url) is. Without a source we
    // update EVERY row sharing the url on purpose: the same posting mirrored
    // under two sources should disappear from the board as one.
    const { rowCount } = source
      ? await pool.query(
          `UPDATE job_posts SET hidden = $1 WHERE url = $2 AND source = $3`,
          [hidden, url, source]
        )
      : await pool.query(`UPDATE job_posts SET hidden = $1 WHERE url = $2`, [hidden, url]);

    if (!rowCount) return jsonResponse(404, { error: "Nincs ilyen hirdetés." });
    // Awaited so the response only returns once jobs.js is guaranteed to stop
    // serving the pre-change list on its NEXT request, not "eventually".
    await bumpJobsCacheGeneration();
    return jsonResponse(200, { ok: true, hidden, updated: rowCount });
  } catch (err) {
    console.error("[job-hidden] error:", err);
    return jsonResponse(500, { error: "Szerver hiba" });
  }
});
