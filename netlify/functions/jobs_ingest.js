const { Pool } = require("pg");

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const INGEST_SECRET = process.env.INGEST_SECRET || ""; // ajánlott!

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type,x-ingest-secret",
      },
      body: "",
    };
  }

  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  // Secret védelem (ha beállítod)
  if (INGEST_SECRET) {
    const headerKey = event.headers?.["x-ingest-secret"] || event.headers?.["X-Ingest-Secret"] || "";
    if (headerKey !== INGEST_SECRET) return json(401, { error: "Unauthorized" });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Invalid JSON" });
  }

  const items = Array.isArray(payload.items) ? payload.items : [];
  if (!items.length) return json(200, { ok: true, upserted: 0 });

  const client = await pool.connect();
  try {
    let upserted = 0;

    for (const it of items) {
      const source = String(it.source || "").trim();
      const title = String(it.title || "").trim();
      const url = String(it.url || "").trim();
      const description = it.description ? String(it.description).trim() : null;

      if (!source || !title || !url) continue;

      await client.query(
        `INSERT INTO job_posts (source, title, url, description, first_seen, last_seen)
         VALUES ($1,$2,$3,$4,NOW(),NOW())
         ON CONFLICT (source, url)
         DO UPDATE SET
           title = EXCLUDED.title,
           description = COALESCE(EXCLUDED.description, job_posts.description),
           last_seen = NOW()`,
        [source, title, url, description]
      );
      upserted++;
    }

    return json(200, { ok: true, upserted });
  } catch (err) {
    console.error(err);
    return json(500, { ok: false, error: err.message });
  } finally {
    client.release();
  }
};
