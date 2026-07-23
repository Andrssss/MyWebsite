// netlify/functions/job-applied.js
// Shared "applied jobs" list for the admins, stored in the DB.
// All admin visitor IDs read/write the SAME shared list (admin_applied_jobs table),
// so whatever one admin marks as "jelentkeztem" / "interjú" is visible to the others.
//
// A row exists while a job has any status. Two flags per job:
//   applied   → "Jelentkeztem"
//   interview → "Interjú" (a sub-state; only meaningful while applied)
//
// Every request needs `Authorization: Bearer $ADMIN_SECRET`.
//
// GET
//   → { applied: ['job:src:url', ...], interview: [...], appliedCache: { 'job:src:url': {job}, ... } }
//   (Key = jobKeyFor() in JobWatcher.jsx: url-keyed; title-keyed only when the
//   entry has no url. Legacy 'job:src:title' rows are migrated by the frontend.)
// POST { adminId, jobKey, applied: bool, interview: bool, job? }
//   Sends the FULL desired state. If both flags are false → row is deleted.
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

// Auth is the ADMIN_SECRET bearer token, NOT a visitor-id allowlist.
//
// This used to gate on four hardcoded UUIDs — which were committed to a public
// repo, so anyone could read them and both dump the shared applied list (GET)
// and flip job_posts.hidden (the mirror below). `adminId` is still accepted, but
// only as an attribution label for `applied_by`; it authorizes nothing.
function authorized(event) {
  const expected = (process.env.ADMIN_SECRET || process.env.CRON_SECRET || "").trim();
  if (!expected) return false;
  const hdr =
    (event.headers && (event.headers.authorization || event.headers.Authorization)) || "";
  const token = hdr.replace(/^Bearer\s+/i, "").trim();
  return token.length > 0 && token === expected;
}

const ensureTable =
  globalThis.__ensureAdminAppliedTable ||
  pool.query(
    `CREATE TABLE IF NOT EXISTS admin_applied_jobs (
       job_key text PRIMARY KEY,
       job_data jsonb NOT NULL DEFAULT '{}'::jsonb,
       applied boolean NOT NULL DEFAULT false,
       interview boolean NOT NULL DEFAULT false,
       applied_by text,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`
  );
globalThis.__ensureAdminAppliedTable = ensureTable;

function corsHeaders(extra = {}) {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
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

  // GET → shared applied/interview lists + cache
  if (event.httpMethod === "GET") {
    if (!authorized(event)) return jsonResponse(401, { error: "Unauthorized" });

    try {
      await ensureTable;
      const { rows } = await pool.query(
        `SELECT job_key, job_data, applied, interview
           FROM admin_applied_jobs
          ORDER BY applied_at DESC`
      );
      const applied = [];
      const interview = [];
      const appliedCache = {};
      for (const r of rows) {
        if (r.applied) applied.push(r.job_key);
        if (r.interview) interview.push(r.job_key);
        appliedCache[r.job_key] = r.job_data || {};
      }
      return jsonResponse(200, { applied, interview, appliedCache });
    } catch (err) {
      console.error("[job-applied] GET error:", err);
      return jsonResponse(500, { error: "Server error" });
    }
  }

  // POST { adminId, jobKey, applied, interview, job? }
  if (event.httpMethod === "POST") {
    if (!authorized(event)) return jsonResponse(401, { error: "Unauthorized" });

    const MAX_BODY_BYTES = 8192;
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

    const adminId = String(payload.adminId || "").trim();
    const jobKey = String(payload.jobKey || "").trim();
    const applied = Boolean(payload.applied);
    const interview = Boolean(payload.interview);
    const job =
      payload.job && typeof payload.job === "object" && !Array.isArray(payload.job)
        ? payload.job
        : {};

    if (!jobKey) return jsonResponse(400, { error: "jobKey is required" });
    if (jobKey.length > 512) return jsonResponse(400, { error: "jobKey too long" });

    try {
      await ensureTable;
      if (!applied && !interview) {
        await pool.query(`DELETE FROM admin_applied_jobs WHERE job_key = $1`, [jobKey]);
      } else {
        await pool.query(
          `INSERT INTO admin_applied_jobs (job_key, job_data, applied, interview, applied_by, applied_at)
           VALUES ($1, $2::jsonb, $3, $4, $5, now())
           ON CONFLICT (job_key) DO UPDATE
             SET applied = EXCLUDED.applied,
                 interview = EXCLUDED.interview,
                 job_data = CASE
                   WHEN EXCLUDED.job_data = '{}'::jsonb THEN admin_applied_jobs.job_data
                   ELSE EXCLUDED.job_data
                 END,
                 applied_by = EXCLUDED.applied_by,
                 applied_at = now()`,
          [jobKey, JSON.stringify(job), applied, interview, adminId]
        );
      }
      // Mirror "applied" onto job_posts.hidden: marking a job applied removes it
      // from the public board, unapplying brings it back. Only possible when we
      // know the row's identity (url) — url-less manual entries have no job_posts row.
      const jobUrl = typeof job.url === "string" ? job.url.trim() : "";
      if (jobUrl) {
        await pool.query(`UPDATE job_posts SET hidden = $1 WHERE url = $2`, [applied, jobUrl]);
      }
      return jsonResponse(200, { ok: true });
    } catch (err) {
      console.error("[job-applied] POST error:", err);
      return jsonResponse(500, { error: "Server error" });
    }
  }

  return jsonResponse(405, { error: "Method not allowed" });
};
