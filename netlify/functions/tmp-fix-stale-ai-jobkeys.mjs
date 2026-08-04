// TEMP one-off — rewrite the 3 admin_applied_jobs rows still carrying a
// pre-migration `AI - <slug>` source (in job_key AND job_data) to the current
// "AI-scraped" bucket name. Data-only fix, no app-code behavior change.
// Disposable — delete after use.
import pkg from "pg";
const { Pool } = pkg;

const connectionString = process.env.NETLIFY_DATABASE_URL;
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });
const TOKEN = "a8c4f0d62b917e5a3c9d17f0b264ea8d1c9b6e4a72f081";

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
      `SELECT job_key, applied_by, job_data->>'source' AS data_source
         FROM admin_applied_jobs
        WHERE job_key LIKE 'job:AI - %' OR job_data->>'source' LIKE 'AI - %'`
    );

    const report = [];
    for (const r of rows) {
      const oldPrefix = `job:${r.data_source}:`;
      if (!r.job_key.startsWith(oldPrefix)) {
        report.push({ job_key: r.job_key, action: "skipped", reason: "prefix mismatch, needs manual look" });
        continue;
      }
      const urlSuffix = r.job_key.slice(oldPrefix.length);
      const newKey = `job:AI-scraped:${urlSuffix}`;

      const { rows: collision } = await client.query(
        `SELECT 1 FROM admin_applied_jobs WHERE job_key = $1 AND applied_by = $2`,
        [newKey, r.applied_by]
      );
      if (collision.length) {
        report.push({ job_key: r.job_key, newKey, action: "skipped", reason: "target key already exists" });
        continue;
      }

      await client.query(
        `UPDATE admin_applied_jobs
            SET job_key = $1,
                job_data = jsonb_set(job_data, '{source}', '"AI-scraped"')
          WHERE job_key = $2 AND applied_by = $3`,
        [newKey, r.job_key, r.applied_by]
      );
      report.push({ oldKey: r.job_key, newKey, action: "updated" });
    }

    return json(200, { report });
  } finally {
    client.release();
  }
};
