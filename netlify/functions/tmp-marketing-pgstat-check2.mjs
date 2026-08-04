// TEMP diagnostic — round 2: did marketing_job_posts grow since the last
// baseline (11046 ins / 11610 upd / 11046 del, captured 2026-08-04 ~19:48 UTC)?
// Disposable — delete after use.
import pkg from "pg";
const { Pool } = pkg;

const connectionString = process.env.NETLIFY_DATABASE_URL;
const pool = connectionString ? new Pool({ connectionString, ssl: { rejectUnauthorized: false } }) : null;
const TOKEN = "a19f4d7c62b8e0913fd6a52c8b7e10493dfa62c1b8e5";

function json(status, body) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

const BASELINE = { ins: 11046, upd: 11610, del: 11046 };

export default async (request) => {
  const url = new URL(request.url);
  if (url.searchParams.get("token") !== TOKEN) return json(401, { error: "Unauthorized" });

  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT relname AS table, n_tup_ins AS ins, n_tup_upd AS upd, n_tup_del AS del
         FROM pg_stat_user_tables
        WHERE relname IN ('marketing_job_posts','marketing_filters','ingatlan_listings','property_listings')
        ORDER BY relname`
    );
    const mjp = rows.find((r) => r.table === "marketing_job_posts");
    const delta = mjp
      ? { ins: Number(mjp.ins) - BASELINE.ins, upd: Number(mjp.upd) - BASELINE.upd, del: Number(mjp.del) - BASELINE.del }
      : null;
    return json(200, { now: new Date().toISOString(), baseline: BASELINE, current: rows, deltaSinceBaseline: delta });
  } finally {
    client.release();
  }
};
