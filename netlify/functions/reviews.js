// netlify/functions/reviews.js
const { Pool } = require("pg");

const pool = new Pool({
  connectionString:  process.env.NETLIFY_DATABASE_URL || null,
  ssl: { rejectUnauthorized: false },
});

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event, context) => {
  const client = await pool.connect();
  try {
    const method = event.httpMethod;
    const path = event.path || "";
    // pl. "/.netlify/functions/reviews/123"
    const parts = path.split("/");
    const maybeId = parts[parts.length - 1];
    const id = /^\d+$/.test(maybeId) ? parseInt(maybeId, 10) : null;

    if (method === "OPTIONS") {
      // ha kéne CORS, itt lehetne, de ugyanazon a domaine fut → nem kell
      return {
        statusCode: 204,
        headers: {},
        body: "",
      };
    }

    // GET /api/reviews → összes vélemény
    // GET /api/reviews/:id → egy vélemény
    if (method === "GET") {
      if (id) {
        const { rows } = await client.query(
          `SELECT
             id,
             name,
             user_name AS "user",
             difficulty,
             usefulness,
             general,
             during_semester AS "duringSemester",
             exam,
             year,
             semester,
             user_id
           FROM subject_reviews
           WHERE id = $1`,
          [id]
        );
        if (rows.length === 0) {
          return jsonResponse(404, { error: "Nem található ilyen vélemény." });
        }
        return jsonResponse(200, rows[0]);
      } else {
        const { rows } = await client.query(
          `SELECT
             id,
             name,
             user_name AS "user",
             difficulty,
             usefulness,
             general,
             during_semester AS "duringSemester",
             exam,
             year,
             semester,
             user_id
           FROM subject_reviews
           ORDER BY semester, name, id`
        );
        return jsonResponse(200, rows);
      }
    }

    // POST /api/reviews → új vélemény
    if (method === "POST") {
      const body = JSON.parse(event.body || "{}");
      const {
        name,
        user = "anonim",
        difficulty = null,
        usefulness = null,
        general = null,
        duringSemester = null,
        exam = null,
        year = null,
        semester = null,
        user_id,
      } = body;

      if (!name || !user_id) {
        return jsonResponse(400, {
          error: "name és user_id kötelező mezők.",
        });
      }

      const { rows } = await client.query(
        `INSERT INTO subject_reviews
          (name, user_name, difficulty, usefulness, general, during_semester, exam, year, semester, user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING
           id,
           name,
           user_name AS "user",
           difficulty,
           usefulness,
           general,
           during_semester AS "duringSemester",
           exam,
           year,
           semester,
           user_id`,
        [
          name,
          user,
          difficulty,
          usefulness,
          general,
          duringSemester,
          exam,
          year,
          semester,
          user_id,
        ]
      );

      return jsonResponse(201, rows[0]);
    }

    // PUT /api/reviews/:id → vélemény frissítése
    if (method === "PUT" && id) {
      const body = JSON.parse(event.body || "{}");
      const fields = [];
      const values = [];
      let idx = 1;

      const map = {
        name: "name",
        user: "user_name",
        difficulty: "difficulty",
        usefulness: "usefulness",
        general: "general",
        duringSemester: "during_semester",
        exam: "exam",
        year: "year",
        semester: "semester",
      };

      for (const [key, column] of Object.entries(map)) {
        if (body[key] !== undefined && body[key] !== "N/A") {
          fields.push(`${column} = $${idx++}`);
          values.push(body[key]);
        }
      }

      if (fields.length === 0) {
        return jsonResponse(400, {
          error: "Nincs frissítendő mező.",
        });
      }

      values.push(id);
      const query = `
        UPDATE subject_reviews
        SET ${fields.join(", ")}
        WHERE id = $${idx}
        RETURNING
          id,
          name,
          user_name AS "user",
          difficulty,
          usefulness,
          general,
          during_semester AS "duringSemester",
          exam,
          year,
          semester,
          user_id
      `;

      const { rows } = await client.query(query, values);
      if (rows.length === 0) {
        return jsonResponse(404, { error: "Nem található ilyen vélemény." });
      }
      return jsonResponse(200, rows[0]);
    }

    // DELETE /api/reviews/:id?user_id=...
    if (method === "DELETE" && id) {
      const params = event.queryStringParameters || {};
      const user_id = params.user_id;
      if (!user_id) {
        return jsonResponse(400, {
          error: "user_id query param kötelező a törléshez.",
        });
      }

      const { rowCount } = await client.query(
        `DELETE FROM subject_reviews WHERE id = $1 AND user_id = $2`,
        [id, user_id]
      );

      if (rowCount === 0) {
        return jsonResponse(404, {
          error: "Nincs ilyen vélemény, vagy nem te vagy a tulajdonos.",
        });
      }
      return jsonResponse(204, {});
    }

    return jsonResponse(405, { error: "Nem támogatott HTTP metódus." });
  } catch (err) {
    console.error("Function error:", err);
    return jsonResponse(500, { error: "Szerver hiba", details: err.message });
  } finally {
    client.release();
  }
};
