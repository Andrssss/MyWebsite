// DISPOSABLE — one-time subject_reviews Postgres → Blob migration.
// Deploy, invoke once with the bearer token below, verify the row count in
// the response matches `SELECT COUNT(*) FROM subject_reviews`, then delete
// this file (separate commit). Do not add a schedule or wire this into
// anything permanent.
import { Pool } from "pg";
import { getStore } from "@netlify/blobs";

const TOKEN = "95045b7183efc33f1900a5563f030a5a6e07522b10a307e8";
const STORE_NAME = "subject-reviews";
const BLOB_KEY = "reviews.json";

export default async (req) => {
  const auth = req.headers.get("authorization") || "";
  if (auth !== `Bearer ${TOKEN}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const pool = new Pool({
    connectionString: process.env.NETLIFY_DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    const { rows } = await pool.query(
      `SELECT
         id, name, user_name AS "user", difficulty, usefulness, general,
         during_semester AS "duringSemester", exam, year, semester, user_id,
         kepzes_fajtaja
       FROM subject_reviews
       ORDER BY id`
    );

    const reviews = rows.map((r) => ({ ...r, likes: [] }));
    const nextId = reviews.reduce((max, r) => Math.max(max, r.id), 0) + 1;

    const store = getStore({ name: STORE_NAME, consistency: "strong" });
    const { modified } = await store.setJSON(
      BLOB_KEY,
      { nextId, reviews },
      { onlyIfNew: true }
    );

    if (!modified) {
      return new Response(
        JSON.stringify({
          error: "Blob already exists — refusing to overwrite. Delete it manually first if a re-migration is intended.",
        }),
        { status: 409, headers: { "content-type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ migrated: reviews.length, nextId }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  } finally {
    await pool.end();
  }
};
