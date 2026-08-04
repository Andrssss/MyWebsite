// TEMP diagnostic — confirm admin_applied_jobs' PK is already (job_key, applied_by)
// before removing the now-obsolete migration code in job-applied.js.
// Disposable — delete after use.
import pkg from "pg";
const { Pool } = pkg;

const connectionString = process.env.NETLIFY_DATABASE_URL;
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });
const TOKEN = "d92e6a1c4f0b873ea5d1c9b6e4a72f0813c6b9e2a5d7f1c";

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
      `SELECT array_agg(kcu.column_name ORDER BY kcu.ordinal_position) AS cols
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
        WHERE tc.table_schema = 'public'
          AND tc.table_name = 'admin_applied_jobs'
          AND tc.constraint_type = 'PRIMARY KEY'
        GROUP BY tc.constraint_name`
    );
    const { rows: legacy } = await client.query(
      `SELECT count(*)::int AS n FROM admin_applied_jobs WHERE applied_by LIKE 'little:%'`
    );
    return json(200, { pkColumns: rows[0]?.cols || null, legacyLittleRows: legacy[0].n });
  } finally {
    client.release();
  }
};
