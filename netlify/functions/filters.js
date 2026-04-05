const { Pool } = require("pg");

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

const ALLOWED_ORIGIN =
  process.env.ALLOWED_ORIGIN || "https://bakan7.netlify.app";

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  const method = event.httpMethod;

  if (method === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
        "Access-Control-Allow-Methods": "GET,POST,DELETE,PATCH,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
      body: "",
    };
  }

  let client;
  try {
    client = await pool.connect();

    // GET – list all filters
    if (method === "GET") {
      const { rows } = await client.query(
        `SELECT id, word FROM job_filters ORDER BY word`
      );
      return json(200, rows);
    }

    // POST – add a filter word
    if (method === "POST") {
      const { word } = JSON.parse(event.body || "{}");
      if (!word) {
        return json(400, { error: "word kötelező." });
      }
      const trimmed = word.trim();
      if (trimmed.length === 0 || trimmed.length > 100) {
        return json(400, { error: "A szó 1-100 karakter között legyen." });
      }
      const { rows } = await client.query(
        `INSERT INTO job_filters (word)
         VALUES ($1)
         ON CONFLICT (LOWER(word)) DO NOTHING
         RETURNING id, word`,
        [trimmed]
      );
      if (rows.length === 0) {
        return json(409, { error: "Ez a szó már létezik." });
      }
      return json(201, rows[0]);
    }

    // DELETE – remove a filter word by id
    if (method === "DELETE") {
      const { id } = JSON.parse(event.body || "{}");
      if (!id) {
        return json(400, { error: "id kötelező." });
      }
      const parsedId = Number(id);
      if (!Number.isFinite(parsedId) || parsedId <= 0) {
        return json(400, { error: "Érvénytelen id." });
      }
      await client.query(`DELETE FROM job_filters WHERE id = $1`, [parsedId]);
      return json(200, { ok: true });
    }

    // PATCH – count or purge jobs matching a filter word (last 1 day only)
    if (method === "PATCH") {
      const { word, action } = JSON.parse(event.body || "{}");
      if (!word || typeof word !== "string") {
        return json(400, { error: "word kötelező." });
      }
      const trimmed = word.trim();
      if (trimmed.length === 0 || trimmed.length > 100) {
        return json(400, { error: "Érvénytelen szó." });
      }

      const whereClause = `WHERE LOWER(title) LIKE '%' || LOWER($1) || '%'
           AND created_at >= NOW() - INTERVAL '1 day'`;

      if (action === "count") {
        const { rows } = await client.query(
          `SELECT COUNT(*)::int AS count FROM job_posts ${whereClause}`,
          [trimmed]
        );
        return json(200, { count: rows[0].count });
      }

      // default: delete
      const result = await client.query(
        `DELETE FROM job_posts ${whereClause}`,
        [trimmed]
      );
      return json(200, { deleted: result.rowCount });
    }

    return json(405, { error: "Nem támogatott metódus." });
  } catch (err) {
    console.error("filters error:", err);
    return json(500, { error: "Szerver hiba", details: err.message });
  } finally {
    client?.release();
  }
};
