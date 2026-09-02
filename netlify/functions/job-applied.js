// netlify/functions/job-applied.js
// "Applied jobs" list, partitioned per owner in the SAME table/DB.
//
// `applied_by` is the partition key, resolved SERVER-SIDE from the visitor
// cookie (never trusted from the client): every admin resolves to the literal
// 'admin' bucket (shared — that's the point, any of them sees what the others
// marked). The read-only "little admin" tier, which used to get its own
// separate bucket here, was removed 2026-09-01; its rows are still in the table
// but nothing resolves to them any more.
//
// A row exists while a job has any status. Two flags per job:
//   applied   → "Jelentkeztem"
//   interview → "Interjú" (a sub-state; only meaningful while applied)
//
// Every request needs `Authorization: Bearer $ADMIN_SECRET` AND a visitor
// cookie recognized by _admin_identity_core — knowing the
// password alone is no longer enough, closing a gap the old UUID-only auth
// didn't have either (anyone with a leaked/guessed secret could hit this
// regardless of who they were).
//
// GET
//   → { applied: ['job:src:url', ...], interview: [...], appliedCache: { 'job:src:url': {job}, ... } }
//   (Key = jobKeyFor() in JobWatcher.jsx: url-keyed; title-keyed only when the
//   entry has no url. Legacy 'job:src:title' rows are migrated by the frontend.)
// POST { jobKey, applied: bool, interview: bool, job? }
//   Sends the FULL desired state. If both flags are false → row is deleted.
//   `applied_by` is NOT client-supplied — it's always the caller's resolved
//   ownerKey, so nobody can write into someone else's bucket by lying about it.
const { Pool } = require("pg");
const { withDbAuditFlush } = require("./_db_audit.js");
const { resolveOwnerKey, hasAdminSecret } = require("./_admin_identity_core");

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
  return hasAdminSecret(event) && resolveOwnerKey(event) !== null;
}

const ensureTable =
  globalThis.__ensureAdminAppliedTable ||
  (async () => {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS admin_applied_jobs (
         job_key text NOT NULL,
         job_data jsonb NOT NULL DEFAULT '{}'::jsonb,
         applied boolean NOT NULL DEFAULT false,
         interview boolean NOT NULL DEFAULT false,
         applied_by text,
         applied_at timestamptz NOT NULL DEFAULT now(),
         PRIMARY KEY (job_key, applied_by)
       )`
    );
  })();
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
    // Shared applied/interview list changes on every write and is read by
    // multiple devices under the same ownerKey bucket — nothing between the
    // browser and this function may cache a pre-change snapshot.
    headers: corsHeaders({ "Cache-Control": "private, no-store", ...extraHeaders }),
    body: JSON.stringify(body),
  };
}

exports.handler = withDbAuditFlush("job-applied", async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(), body: "" };
  }

  // GET → this caller's applied/interview list + cache (own bucket only)
  if (event.httpMethod === "GET") {
    if (!authorized(event)) return jsonResponse(401, { error: "Unauthorized" });
    const ownerKey = resolveOwnerKey(event);

    try {
      await ensureTable;
      const { rows } = await pool.query(
        `SELECT job_key, job_data, applied, interview
           FROM admin_applied_jobs
          WHERE applied_by = $1
          ORDER BY applied_at DESC`,
        [ownerKey]
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
    const ownerKey = resolveOwnerKey(event);

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
        await pool.query(`DELETE FROM admin_applied_jobs WHERE job_key = $1 AND applied_by = $2`, [
          jobKey,
          ownerKey,
        ]);
      } else {
        await pool.query(
          `INSERT INTO admin_applied_jobs (job_key, job_data, applied, interview, applied_by, applied_at)
           VALUES ($1, $2::jsonb, $3, $4, $5, now())
           ON CONFLICT (job_key, applied_by) DO UPDATE
             SET applied = EXCLUDED.applied,
                 interview = EXCLUDED.interview,
                 job_data = CASE
                   WHEN EXCLUDED.job_data = '{}'::jsonb THEN admin_applied_jobs.job_data
                   ELSE EXCLUDED.job_data
                 END,
                 applied_at = now()`,
          [jobKey, JSON.stringify(job), applied, interview, ownerKey]
        );
      }
      return jsonResponse(200, { ok: true });
    } catch (err) {
      console.error("[job-applied] POST error:", err);
      return jsonResponse(500, { error: "Server error" });
    }
  }

  return jsonResponse(405, { error: "Method not allowed" });
});
