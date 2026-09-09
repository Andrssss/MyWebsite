// Disposable one-off endpoint — registers "kibernaptar" as a recurring
// event_sources listing page. Deploy, invoke once, then delete this file.
import { Pool } from "pg";

const TOKEN = "db68931bdb9aa4dd348392aeb6d94b853b014f589b3376a5";
const pool = new Pool({ connectionString: process.env.NETLIFY_DATABASE_URL, ssl: { rejectUnauthorized: false } });

export default async (request) => {
  const auth = request.headers.get("authorization") || "";
  if (auth !== `Bearer ${TOKEN}`) return new Response("Unauthorized", { status: 401 });

  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS event_sources (
        site        text PRIMARY KEY,
        list_url    text NOT NULL,
        mode        text NOT NULL DEFAULT 'llm-read',
        last_ok     timestamptz,
        fail_streak int NOT NULL DEFAULT 0
      )
    `);
    const { rows } = await client.query(
      `INSERT INTO event_sources (site, list_url) VALUES ($1, $2)
       ON CONFLICT (site) DO NOTHING RETURNING site, list_url`,
      ["kibernaptar", "https://kibernaptar.hu/esemenylista/"]
    );
    const all = await client.query(`SELECT site, list_url, mode FROM event_sources ORDER BY site`);
    return new Response(JSON.stringify({ inserted: rows[0] || null, all: all.rows }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } finally {
    client.release();
  }
};
