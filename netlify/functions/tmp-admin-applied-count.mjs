// TEMP diagnostic — reconcile "113 updates delta" against actual row count /
// content of admin_applied_jobs. Disposable — delete after use.
import pkg from "pg";
const { Pool } = pkg;

const connectionString = process.env.NETLIFY_DATABASE_URL;
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });
const TOKEN = "c4f1a9b7e3d0862fa5c1b9e6d4a72f0813c6b9e2a5d7f1";

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
    const { rows: countRows } = await client.query(`SELECT count(*)::int AS total FROM admin_applied_jobs`);
    const { rows: byOwner } = await client.query(
      `SELECT applied_by, count(*)::int AS n FROM admin_applied_jobs GROUP BY applied_by ORDER BY n DESC`
    );
    const { rows: statNow } = await client.query(
      `SELECT n_tup_ins AS ins, n_tup_upd AS upd, n_tup_del AS del FROM pg_stat_user_tables WHERE relname = 'admin_applied_jobs'`
    );
    const { rows: sample } = await client.query(
      `SELECT job_key, applied, interview, applied_by, applied_at FROM admin_applied_jobs ORDER BY applied_at DESC LIMIT 5`
    );
    return json(200, { now: new Date().toISOString(), totalRows: countRows[0].total, byOwner, pgStatNow: statNow[0], mostRecentlyTouched: sample });
  } finally {
    client.release();
  }
};
