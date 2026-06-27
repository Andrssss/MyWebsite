const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.NETLIFY_DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "https://bakan7.netlify.app";

const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX = 3;

const hits = globalThis.__subjectRequestHits || new Map();
globalThis.__subjectRequestHits = hits;

const ensureTablePromise =
  globalThis.__ensureSubjectRequestsTable ||
  pool.query(`
    CREATE TABLE IF NOT EXISTS subject_requests (
      id serial PRIMARY KEY,
      subject_name text NOT NULL,
      semester integer,
      note text,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `).then(() =>
    pool.query(`ALTER TABLE subject_requests ADD COLUMN IF NOT EXISTS semester integer`)
  );
globalThis.__ensureSubjectRequestsTable = ensureTablePromise;

function corsHeaders(extra = {}) {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    ...extra,
  };
}

function json(statusCode, body, extra = {}) {
  return { statusCode, headers: corsHeaders(extra), body: JSON.stringify(body) };
}

function getIp(event) {
  const h = event.headers || {};
  return (
    (h["x-forwarded-for"] || "").split(",")[0].trim() ||
    h["x-nf-client-connection-ip"] ||
    "unknown"
  );
}

function checkRateLimit(key) {
  const now = Date.now();
  const minTs = now - RATE_LIMIT_WINDOW_MS;
  const timestamps = (hits.get(key) || []).filter((ts) => ts > minTs);
  timestamps.push(now);
  hits.set(key, timestamps);
  if (timestamps.length > RATE_LIMIT_MAX) {
    return Math.max(1, Math.ceil((timestamps[0] + RATE_LIMIT_WINDOW_MS - now) / 1000));
  }
  return 0;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(), body: "" };
  }
  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method not allowed" });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Invalid JSON" });
  }

  const ip = getIp(event);
  const retryAfter = checkRateLimit(`ip:${ip}`);
  if (retryAfter > 0) {
    return json(429, { error: "Túl sok kérés, próbáld később." }, { "Retry-After": String(retryAfter) });
  }

  const subjectName = String(body.subjectName || "").trim().slice(0, 200);
  if (!subjectName) {
    return json(400, { error: "A tárgynév megadása kötelező." });
  }

  const semesterRaw = parseInt(body.semester, 10);
  const semester = Number.isInteger(semesterRaw) && semesterRaw >= 1 && semesterRaw <= 14 ? semesterRaw : null;
  const note = String(body.note || "").trim().slice(0, 1000) || null;

  try {
    await ensureTablePromise;
    await pool.query(
      `INSERT INTO subject_requests (subject_name, semester, note) VALUES ($1, $2, $3)`,
      [subjectName, semester, note]
    );
    return json(200, { ok: true });
  } catch (err) {
    console.error("[subject-request] POST error:", err);
    return json(500, { error: "Szerver hiba, próbáld újra." });
  }
};
