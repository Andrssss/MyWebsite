// DISPOSABLE — 2026-09-15. Direct lookup of the reported QuantumBlack row's
// current DB state. Delete after use.
import { Pool } from "pg";

const TOKEN = "b4e7f1a9c2d6083f5b7e1a9c4d8f2b6e0a3c7d15";
const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });

  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT id, url, active, technologies, last_seen FROM job_posts WHERE url ILIKE $1`,
      ["%data-science-consultant-quantumblack%"]
    );
    return new Response(JSON.stringify(rows, null, 2), {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  } finally {
    client.release();
  }
};
