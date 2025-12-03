// netlify/functions/reviews.js
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
      return {
        statusCode: 204,
        headers: {},
        body: "",
      };
    }

    // ───────────────── GET ─────────────────
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

    // ───────────────── POST ─────────────────
    if (method === "POST") {
      const body = JSON.parse(event.body || "{}");

      const {
        name,
        user = "anonim",
        general = null,
        duringSemester = null,
        exam = null,
        user_id,
      } = body;

      // Speciális: "Általános információ" tárgyra ne lehessen POST-olni
      if (name && name.trim() === "Általános információ") {
        return jsonResponse(400, {
          error: "Ehhez a tárgyhoz nem lehet új véleményt hozzáadni.",
        });
      }

      const toIntOrNull = (v, fieldName) => {
        if (v === undefined || v === null || v === "") return null;
        const n = parseInt(v, 10);
        if (Number.isNaN(n)) {
          throw new Error(`Invalid integer value for ${fieldName}: ${v}`);
        }
        return n;
      };

      const difficulty = toIntOrNull(body.difficulty, "difficulty");
      const usefulness = toIntOrNull(body.usefulness, "usefulness");
      const year = toIntOrNull(body.year, "year");
      const semester = toIntOrNull(body.semester, "semester");

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

    // ───────────────── PUT ─────────────────
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

        // ───────────────── PUT ─────────────────
    if (method === "PUT" && id) {
      // ... (ez maradhat ahogy van)
    }

    // ───────────────── DELETE ─────────────────
    if (method === "DELETE" && id) {
      console.log("🔥 DELETE called, id from path =", id);

      const { rowCount } = await client.query(
        `DELETE FROM subject_reviews WHERE id = $1`,
        [id]
      );

      if (rowCount === 0) {
        console.log("❌ Nincs sor ezzel az id-vel:", id);
        return jsonResponse(404, {
          error: "Nincs ilyen vélemény (id nem található).",
        });
      }

      console.log("✅ Sikeres törlés, id =", id);

      return {
        statusCode: 204,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
        },
        body: "",
      };
    }

    // Ha egyik sem
    return jsonResponse(405, { error: "Nem támogatott HTTP metódus." });
  } catch (err) {
    console.error("Function error:", err);
    return jsonResponse(500, { error: "Szerver hiba", details: err.message });
  } finally {
    client.release();
  }
};


