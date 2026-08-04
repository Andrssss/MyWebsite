// TEMP diagnostic — confirm zero legacy 'AI - <slug>' rows remain before
// removing migrateLegacyAiSources() from ai-registry.mjs. Disposable — delete after use.
import pkg from "pg";
const { Pool } = pkg;

const connectionString = process.env.NETLIFY_DATABASE_URL;
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });
const TOKEN = "e5a3c9d17f0b264ea8d1c9b6e4a72f0813c6b9e2a5d7f1c";

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
      `SELECT count(*)::int AS n FROM job_posts WHERE source LIKE 'AI - %'`
    );
    return json(200, { legacyRows: rows[0].n });
  } finally {
    client.release();
  }
};
