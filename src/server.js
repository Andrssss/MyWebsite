// server.js
import express from "express";
import cors from "cors";
import { Pool } from "pg";

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL, // env-ben állítod be
});

app.get("/api/reviews", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, user_name AS "user",
              difficulty, general,
              during_semester AS "duringSemester",
              exam, year, semester, user_id
       FROM subject_reviews
       ORDER BY name, year DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).send("DB hiba");
  }
});

app.post("/api/reviews", async (req, res) => {
  try {
    const {
      name,
      user,
      difficulty,
      general,
      duringSemester,
      exam,
      year,
      semester,
      user_id,
    } = req.body;

    const { rows } = await pool.query(
      `INSERT INTO subject_reviews
        (name, user_name, difficulty, general, during_semester, exam, year, semester, user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id, name, user_name AS "user",
                 difficulty, general, during_semester AS "duringSemester",
                 exam, year, semester, user_id`,
      [
        name,
        user || "anonim",
        difficulty || null,
        general || null,
        duringSemester || null,
        exam || null,
        year,
        semester,
        user_id,
      ]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).send("DB hiba");
  }
});

app.put("/api/reviews/:id", async (req, res) => {
  const { id } = req.params;
  const {
    name,
    user,
    difficulty,
    general,
    duringSemester,
    exam,
    year,
    semester,
    user_id,
  } = req.body;

  try {
    // opcionális: ellenőrzés, hogy user_id egyezik-e
    const { rows } = await pool.query(
      `UPDATE subject_reviews
       SET name=$1,
           user_name=$2,
           difficulty=$3,
           general=$4,
           during_semester=$5,
           exam=$6,
           year=$7,
           semester=$8
       WHERE id=$9 AND user_id=$10
       RETURNING id, name, user_name AS "user",
                 difficulty, general, during_semester AS "duringSemester",
                 exam, year, semester, user_id`,
      [
        name,
        user || "anonim",
        difficulty || null,
        general || null,
        duringSemester || null,
        exam || null,
        year,
        semester,
        id,
        user_id,
      ]
    );
    if (!rows.length) return res.status(403).send("Nincs jogosultság / nincs ilyen sor");
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).send("DB hiba");
  }
});

app.delete("/api/reviews/:id", async (req, res) => {
  const { id } = req.params;
  const { user_id } = req.query;

  try {
    const { rowCount } = await pool.query(
      `DELETE FROM subject_reviews WHERE id=$1 AND user_id=$2`,
      [id, user_id]
    );
    if (!rowCount) return res.status(403).send("Nincs jogosultság / nincs ilyen sor");
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).send("DB hiba");
  }
});

const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log("API running on port", port);
});
