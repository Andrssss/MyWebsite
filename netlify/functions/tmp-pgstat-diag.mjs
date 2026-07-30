// TEMPORARY one-off — read-only diagnostic. Returns Postgres's own per-table
// write counters (pg_stat_user_tables), which increment on EVERY row-level
// insert/update/delete regardless of which client/code path caused it —
// ground truth independent of application-side log/audit blind spots.
// Delete after use.
import pkg from "pg";
const { Pool } = pkg;

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });
const ONE_OFF_TOKEN = "8a21d868f3c4636dbeb1e4258376e92aa641384807793d4f";

function json(status, body) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export default async (request) => {
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (token !== ONE_OFF_TOKEN) return json(401, { error: "Unauthorized" });

  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT relname AS table,
              n_tup_ins AS ins,
              n_tup_upd AS upd,
              n_tup_del AS del,
              n_tup_hot_upd AS hot_upd,
              n_live_tup AS live,
              n_dead_tup AS dead,
              last_autovacuum,
              last_autoanalyze
         FROM pg_stat_user_tables
        ORDER BY (n_tup_upd + n_tup_del) DESC`
    );
    const { rows: statsReset } = await client.query(`SELECT stats_reset FROM pg_stat_database WHERE datname = current_database()`);
    return json(200, { now: new Date().toISOString(), statsSince: statsReset[0]?.stats_reset, tables: rows });
  } finally {
    client.release();
  }
};
