// netlify/functions/job-applied.js
// Shared "applied jobs" list for the admins, stored in the DB.
// All admin visitor IDs read/write the SAME shared list (admin_applied_jobs table),
// so whatever one admin marks as "jelentkeztem" / "interjú" is visible to the others.
//
// A row exists while a job has any status. Two flags per job:
//   applied   → "Jelentkeztem"
//   interview → "Interjú" (a sub-state; only meaningful while applied)
//
// GET  ?adminId=xxx
//   → { applied: ['job:src:title', ...], interview: [...], appliedCache: { 'job:src:title': {job}, ... } }
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

const ADMIN_VISITOR_IDS = new Set([
  "43e878e0-f5fd-45f3-bfd4-9473e5deec11",
  "69872482-1311-4702-a5e5-a782ca9f2669",
  "82906f93-dfbb-4684-b2b1-a948b99553e0",
  "b878ceed-55b7-47db-87ec-c4e2825246f8",
]);

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

  // GET ?adminId=xxx → shared applied/interview lists + cache
  if (event.httpMethod === "GET") {
    const adminId = String(event.queryStringParameters?.adminId || "").trim();
    if (!ADMIN_VISITOR_IDS.has(adminId)) {
      return jsonResponse(403, { error: "Forbidden" });
    }

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

    if (!ADMIN_VISITOR_IDS.has(adminId)) return jsonResponse(403, { error: "Forbidden" });
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
      return jsonResponse(200, { ok: true });
    } catch (err) {
      console.error("[job-applied] POST error:", err);
      return jsonResponse(500, { error: "Server error" });
    }
  }

  return jsonResponse(405, { error: "Method not allowed" });
};
