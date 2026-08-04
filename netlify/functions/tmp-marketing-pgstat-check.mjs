// TEMP diagnostic — is marketing_job_posts still being written to right now?
// pg_stat_user_tables counters are cumulative since last stats reset; taking
// two snapshots apart and diffing shows live activity or its absence.
// Disposable — delete after use.
import pkg from "pg";
const { Pool } = pkg;

const connectionString = process.env.NETLIFY_DATABASE_URL;
const pool = connectionString ? new Pool({ connectionString, ssl: { rejectUnauthorized: false } }) : null;
const TOKEN = "b7e2f0c1d5a94836ef1c02d9a6b4f7e83c5d1a0946fb2";

function json(status, body) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export default async (request) => {
  const url = new URL(request.url);
  if (url.searchParams.get("token") !== TOKEN) return json(401, { error: "Unauthorized" });

  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT relname AS table, n_tup_ins AS ins, n_tup_upd AS upd, n_tup_del AS del,
              last_autovacuum, last_autoanalyze
         FROM pg_stat_user_tables
        WHERE relname IN ('marketing_job_posts','marketing_filters','ingatlan_listings','property_listings')
        ORDER BY relname`
    );
    // also grab any currently-active/idle backend connected under a role/app
    // name we don't recognize, in case the other app's writer is live right now
    const { rows: activity } = await client.query(
      `SELECT pid, usename, application_name, client_addr, state, query_start, state_change,
              left(query, 120) AS query_snippet
         FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()
        ORDER BY query_start DESC NULLS LAST`
    );
    return json(200, { now: new Date().toISOString(), tables: rows, activity });
  } finally {
    client.release();
  }
};
