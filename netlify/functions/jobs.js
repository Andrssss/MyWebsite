// netlify/functions/jobs.js
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

function jsonResponse(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "https://bakan7.netlify.app",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}

// FIXED lista (key/label)
const FIXED = [
  { key: "karrierhungaria", label: "Karrier Hungaria" },
  { key: "aam", label: "AAM" },
  { key: "frissdiplomas", label: "Frissdiplomas" },
  { key: "minddiak", label: "Minddiák" },
  { key: "muisz", label: "Muisz" },
  { key: "cvcentrum-gyakornok-it", label: "CV Centrum" },
  { key: "zyntern", label: "Zyntern" },
  { key: "profession-intern", label: "Profession" },
  { key: "schonherz", label: "Schönherz – Budapest" },
  { key: "tudasdiak", label: "Tudasdiak" },
  { key: "otp", label: "OTP" },
  { key: "vizmuvek", label: "vizmuvek" },
  { key: "LinkedIn", label: "LinkedIn PAST 24H" },
  { key: "cvonline", label: "cvonline" },
  { key: "wherewework", label: "wherewework" },
  { key: "onejob", label: "onejob" },
  { key: "nofluffjobs", label: "nofluffjobs" },
  { key: "dreamjobs", label: "DreamJobs" },
  { key: "melonjobs", label: "MelonJobs" },
  { key: "kuka", label: "KUKA" },
  { key: "tesco", label: "Tesco" },
  { key: "talent", label: "Talent" },
  { key: "bluebird", label: "bluebird" },

];

exports.handler = async (event) => {
  const client = await pool.connect();
  try {
    const method = event.httpMethod;
    const path = event.path || "";
    const parts = path.split("/");
    const maybeId = parts[parts.length - 1];
    const id = /^\d+$/.test(maybeId) ? parseInt(maybeId, 10) : null;

    if (method === "OPTIONS") {
      return {
        statusCode: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
        body: "",
      };
    }

    if (method === "GET") {
      const qs = event.queryStringParameters || {};
      const source = qs.source || null;
      const onlyNew = qs.onlyNew === "1" || qs.onlyNew === "true";
      const timeRangeRaw = String(qs.timeRange || "").toLowerCase();
      const timeRange =
        timeRangeRaw === "24h" || timeRangeRaw === "1d"
          ? "24h"
          : timeRangeRaw === "7d" || timeRangeRaw === "1w" || timeRangeRaw === "week"
          ? "7d"
          : onlyNew
          ? "24h"
          : null;
      const limit = Math.min(parseInt(qs.limit || "500", 10) || 500, 5000);

      // GET /jobs/sources
      if (path.endsWith("/jobs/sources") || path.endsWith("/jobs/sources/")) {
        const { rows } = await client.query(`
          SELECT source,
                 COUNT(*)::int AS count
          FROM job_posts
          GROUP BY source
        `);

        const map = new Map(rows.map((r) => [r.source, r]));
        const out = FIXED.map((s) => ({
          source: s.key,
          label: s.label,
          count: map.get(s.key)?.count ?? 0,
        }));

        return jsonResponse(200, out);
      }

      // GET /jobs/:id
      if (id) {
        const { rows } = await client.query(
          `SELECT source, title, url,
                  first_seen AS "firstSeen",
                  experience
           FROM job_posts
           WHERE id = $1`,
          [id]
        );
        if (rows.length === 0) return jsonResponse(404, { error: "Nem található." });
        return jsonResponse(200, rows[0]);
      }

      // GET /jobs?source=...
      if (source) {
        const sourceQuery = timeRange === "24h"
          ? `SELECT source, title, url,
                    first_seen AS "firstSeen",
                    experience
             FROM job_posts
             WHERE source = $1
               AND first_seen >= NOW() - INTERVAL '24 hours'
             ORDER BY first_seen DESC, id DESC
             LIMIT $2`
          : timeRange === "7d"
          ? `SELECT source, title, url,
                    first_seen AS "firstSeen",
                    experience
             FROM job_posts
             WHERE source = $1
               AND first_seen >= NOW() - INTERVAL '7 days'
             ORDER BY first_seen DESC, id DESC
             LIMIT $2`
          : `SELECT source, title, url,
                    first_seen AS "firstSeen",
                    experience
             FROM job_posts
             WHERE source = $1
             ORDER BY first_seen DESC, id DESC
             LIMIT $2`;

        const { rows } = await client.query(sourceQuery, [source, limit]);
        return jsonResponse(200, rows);
      }

      // GET /jobs
            const allQuery = timeRange === "24h"
        ? `SELECT source, title, url,
                  first_seen AS "firstSeen",
                  experience
           FROM job_posts
           WHERE first_seen >= NOW() - INTERVAL '24 hours'
           ORDER BY first_seen DESC, id DESC
           LIMIT $1`
         : timeRange === "7d"
         ? `SELECT source, title, url,
              first_seen AS "firstSeen",
              experience
            FROM job_posts
            WHERE first_seen >= NOW() - INTERVAL '7 days'
            ORDER BY first_seen DESC, id DESC
            LIMIT $1`
        : `SELECT source, title, url,
                  first_seen AS "firstSeen",
                  experience
           FROM job_posts
           ORDER BY first_seen DESC, id DESC
           LIMIT $1`;

      const { rows } = await client.query(allQuery, [limit]);
      return jsonResponse(200, rows);
    }

    if (method === "DELETE") {
      return jsonResponse(403, {
        error: "A törlés API-ból tiltva van.",
      });
    }

    return jsonResponse(405, { error: "Nem támogatott HTTP metódus." });
  } catch (err) {
    console.error("Function error:", err);
    return jsonResponse(500, { error: "Szerver hiba", details: err.message });
  } finally {
    client.release();
  }
};
