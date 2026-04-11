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

    // GET – list all categories with keywords
    if (method === "GET") {
      const { rows } = await client.query(
        `SELECT id, name, keywords FROM job_categories ORDER BY id`
      );
      return json(200, rows);
    }

    // POST – add a new category
    if (method === "POST") {
      const { name, keywords } = JSON.parse(event.body || "{}");
      if (!name || typeof name !== "string") {
        return json(400, { error: "name kötelező." });
      }
      const trimmedName = name.trim();
      if (trimmedName.length === 0 || trimmedName.length > 100) {
        return json(400, { error: "A név 1-100 karakter között legyen." });
      }
      const kws = Array.isArray(keywords)
        ? keywords.map((k) => String(k).trim()).filter(Boolean)
        : [];

      const { rows } = await client.query(
        `INSERT INTO job_categories (name, keywords)
         VALUES ($1, $2)
         ON CONFLICT (name) DO NOTHING
         RETURNING id, name, keywords`,
        [trimmedName, kws]
      );
      if (rows.length === 0) {
        return json(409, { error: "Ez a kategória már létezik." });
      }
      return json(201, rows[0]);
    }

    // PATCH – update keywords for a category
    if (method === "PATCH") {
      const { id, keywords } = JSON.parse(event.body || "{}");
      if (!id) {
        return json(400, { error: "id kötelező." });
      }
      const parsedId = Number(id);
      if (!Number.isFinite(parsedId) || parsedId <= 0) {
        return json(400, { error: "Érvénytelen id." });
      }
      if (!Array.isArray(keywords)) {
        return json(400, { error: "keywords tömb kötelező." });
      }
      const kws = keywords.map((k) => String(k).trim()).filter(Boolean);
      const { rows } = await client.query(
        `UPDATE job_categories SET keywords = $2 WHERE id = $1
         RETURNING id, name, keywords`,
        [parsedId, kws]
      );
      if (rows.length === 0) {
        return json(404, { error: "Kategória nem található." });
      }
      return json(200, rows[0]);
    }

    // DELETE – remove a category by id
    if (method === "DELETE") {
      const { id } = JSON.parse(event.body || "{}");
      if (!id) {
        return json(400, { error: "id kötelező." });
      }
      const parsedId = Number(id);
      if (!Number.isFinite(parsedId) || parsedId <= 0) {
        return json(400, { error: "Érvénytelen id." });
      }
      await client.query(`DELETE FROM job_categories WHERE id = $1`, [parsedId]);
      return json(200, { ok: true });
    }

    return json(405, { error: "Nem támogatott metódus." });
  } catch (err) {
    console.error("categories error:", err);
    return json(500, { error: "Szerver hiba", details: err.message });
  } finally {
    client?.release();
  }
};
