// TEMP diagnostic — find admin_applied_jobs rows whose job_key/job_data still
// embed a pre-migration `AI - <slug>` source instead of the current
// "AI-scraped" bucket name. Disposable — delete after use.
import pkg from "pg";
const { Pool } = pkg;

const connectionString = process.env.NETLIFY_DATABASE_URL;
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });
const TOKEN = "f6b2d8a4c1e97350af6d2c9b7e4a72f0813c6b9e2a5d7f1c";

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
      `SELECT job_key, applied_by, job_data->>'source' AS data_source, applied_at
         FROM admin_applied_jobs
        WHERE job_key LIKE 'job:AI - %' OR job_data->>'source' LIKE 'AI - %'
        ORDER BY applied_at DESC`
    );
    return json(200, { count: rows.length, rows });
  } finally {
    client.release();
  }
};
