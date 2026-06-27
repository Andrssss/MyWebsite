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
             user_id,
             kepzes_fajtaja
           FROM subject_reviews
           WHERE id = $1`,
          [id]
        );
        if (rows.length === 0) {
          return jsonResponse(404, { error: "Nem található ilyen vélemény." });
        }
        return jsonResponse(200, rows[0]);
      } else {
        // Opcionális ?limit=N → csak az első N tárgy összes véleménye.
        // Tárgyanként (név szerint) limitálunk, nem soronként, hogy a
        // kártyák csoportosítása ne törjön ketté a határon.
        const limitRaw = event.queryStringParameters?.limit;
        const limit = /^\d+$/.test(limitRaw || "") ? parseInt(limitRaw, 10) : null;

        const selectCols = `
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
             user_id,
             kepzes_fajtaja`;

        if (limit) {
          // Az "Általános információ" mindig kerüljön be (és legyen elöl),
          // a maradék helyet töltsük fel félév/név szerint.
          const { rows } = await client.query(
            `SELECT ${selectCols}
               FROM subject_reviews
              WHERE name IN (
                SELECT name
                  FROM subject_reviews
                 GROUP BY name
                 ORDER BY (lower(btrim(name)) = lower('Általános információ')) DESC,
                          MIN(semester) NULLS LAST, name
                 LIMIT $1
              )
              ORDER BY semester, name, id`,
            [limit]
          );
          return jsonResponse(200, rows);
        }

        const { rows } = await client.query(
          `SELECT ${selectCols}
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
        user: rawUser = "",
        general = null,
        duringSemester = null,
        exam = null,
        user_id,
        kepzes_fajtaja = "MI",
      } = body;

      const user = (typeof rawUser === "string" ? rawUser.trim() : "") || "anonim";

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
          (name, user_name, difficulty, usefulness, general, during_semester, exam, year, semester, user_id, kepzes_fajtaja)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
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
          user_id,
          kepzes_fajtaja`,
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
          kepzes_fajtaja,
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
        user_id: "user_id",
        kepzes_fajtaja: "kepzes_fajtaja",
      };

      for (const [key, column] of Object.entries(map)) {
        if (body[key] !== undefined && body[key] !== "N/A") {
          let value = body[key];
          if (key === "user") {
            value = (typeof value === "string" ? value.trim() : "") || "anonim";
          }
          fields.push(`${column} = $${idx++}`);
          values.push(value);
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
          user_id,
          kepzes_fajtaja
        `;

      const { rows } = await client.query(query, values);
      if (rows.length === 0) {
        return jsonResponse(404, { error: "Nem található ilyen vélemény." });
      }
      return jsonResponse(200, rows[0]);
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


