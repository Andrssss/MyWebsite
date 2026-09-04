// DISPOSABLE — one-off cleanup endpoint. Deploy, invoke once, then delete.
// See CLAUDE.md "Deploy & one-off writes workflow".
//
// ats_tenants / ats_slug_candidates / ats_seen_companies moved to the
// "ats-state" Netlify Blob store on 2026-09-03 (see _ats_state.mjs); rows
// were carried over by the now-deleted tmp-ats-migrate.mjs (335 tenants,
// 2473 candidates, 1415 seen companies). Nothing reads these three tables
// anymore — this drops them.

import pkg from "pg";
const { Pool } = pkg;

const TOKEN = "8952264f63fbcee58b8ab65e35e21ca62b8382619f49de11";

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

const TABLES = ["ats_tenants", "ats_slug_candidates", "ats_seen_companies"];

export default async (req) => {
  const auth = req.headers.get("authorization") || "";
  if (auth !== `Bearer ${TOKEN}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const client = await pool.connect();
  try {
    const rowsAtDropTime = {};
    for (const table of TABLES) {
      const { rows } = await client.query(`SELECT COUNT(*)::int AS n FROM ${table}`);
      rowsAtDropTime[table] = rows[0].n;
    }

    for (const table of TABLES) {
      await client.query(`DROP TABLE ${table}`);
    }

    return new Response(
      JSON.stringify({ dropped: TABLES, rowsAtDropTime }, null, 2),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }, null, 2), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  } finally {
    client.release();
  }
};
