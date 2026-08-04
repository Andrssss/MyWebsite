// TEMP diagnostic — user spotted "ai:novaservices"-style sources (lowercase,
// colon-separated) still around, a DIFFERENT legacy naming scheme than the
// "AI - <slug>" one already handled. Check scope in job_posts AND
// admin_applied_jobs. Disposable — delete after use.
import pkg from "pg";
const { Pool } = pkg;

const connectionString = process.env.NETLIFY_DATABASE_URL;
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });
const TOKEN = "b3d7f1a9c5e02684af6d2c9b7e4a72f0813c6b9e2a5d7";

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
    const { rows: distinctSources } = await client.query(
      `SELECT source, count(*)::int AS n
         FROM job_posts
        WHERE source ILIKE 'ai:%' OR source ILIKE 'ai%-%' OR source ILIKE '%ai - %' OR source ILIKE 'ai_%'
        GROUP BY source
        ORDER BY n DESC`
    );
    const { rows: allAiLike } = await client.query(
      `SELECT DISTINCT source FROM job_posts WHERE source ILIKE '%ai%' ORDER BY source`
    );
    const { rows: appliedJobs } = await client.query(
      `SELECT job_key, applied_by, job_data->>'source' AS data_source
         FROM admin_applied_jobs
        WHERE job_key ILIKE 'job:ai:%' OR job_data->>'source' ILIKE 'ai:%'`
    );
    return json(200, { colonStyleInJobPosts: distinctSources, allDistinctSourcesContainingAi: allAiLike, staleAppliedJobs: appliedJobs });
  } finally {
    client.release();
  }
};
