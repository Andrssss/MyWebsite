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
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}

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
          "Access-Control-Allow-Methods": "GET,DELETE,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
        body: "",
      };
    }

    // GET /jobs?source=...&limit=...
    if (method === "GET") {
      const qs = event.queryStringParameters || {};
      const source = qs.source || null;
      const limit = Math.min(parseInt(qs.limit || "500", 10) || 500, 1000);

      // ✅ ÚJ: GET /jobs/sources  (források listája tabokhoz)
      // Netlify path tipikusan: "/.netlify/functions/jobs/sources"
      if (path.endsWith("/jobs/sources") || path.endsWith("/jobs/sources/")) {
        const { rows } = await client.query(
          `SELECT
             source AS key,
             source AS label,
             COUNT(*)::int AS count,
             MAX(last_seen) AS "lastSeen"
           FROM job_posts
           GROUP BY source
           ORDER BY count DESC, source ASC`
        );

        return jsonResponse(200, rows, { "Access-Control-Allow-Origin": "*" });
      }

      if (id) {
        const { rows } = await client.query(
          `SELECT id, source, title, url, description,
                  first_seen AS "firstSeen",
                  last_seen  AS "lastSeen"
           FROM job_posts
           WHERE id = $1`,
          [id]
        );
        if (rows.length === 0) return jsonResponse(404, { error: "Nem található." }, { "Access-Control-Allow-Origin": "*" });
        return jsonResponse(200, rows[0], { "Access-Control-Allow-Origin": "*" });
      }

      if (source) {
        const { rows } = await client.query(
          `SELECT id, source, title, url, description,
                  first_seen AS "firstSeen",
                  last_seen  AS "lastSeen"
           FROM job_posts
           WHERE source = $1
           ORDER BY first_seen DESC, id DESC
           LIMIT $2`,
          [source, limit]
        );
        return jsonResponse(200, rows, { "Access-Control-Allow-Origin": "*" });
      }

      const { rows } = await client.query(
        `SELECT id, source, title, url, description,
                first_seen AS "firstSeen",
                last_seen  AS "lastSeen"
         FROM job_posts
         ORDER BY first_seen DESC, id DESC
         LIMIT $1`,
        [limit]
      );
      return jsonResponse(200, rows, { "Access-Control-Allow-Origin": "*" });
    }

    // DELETE /jobs/:id
    if (method === "DELETE" && id) {
      const { rowCount } = await client.query(`DELETE FROM job_posts WHERE id = $1`, [id]);
      if (rowCount === 0) return jsonResponse(404, { error: "Nincs ilyen id." }, { "Access-Control-Allow-Origin": "*" });

      return {
        statusCode: 204,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
        },
        body: "",
      };
    }

    return jsonResponse(405, { error: "Nem támogatott HTTP metódus." }, { "Access-Control-Allow-Origin": "*" });
  } catch (err) {
    console.error("Function error:", err);
    return jsonResponse(500, { error: "Szerver hiba", details: err.message }, { "Access-Control-Allow-Origin": "*" });
  } finally {
    client.release();
  }
};
