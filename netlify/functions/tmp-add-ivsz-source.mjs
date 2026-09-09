// Disposable one-off endpoint — registers "ivsz" as a recurring event_sources
// listing page. Deploy, invoke once, then delete this file.
import { Pool } from "pg";

const TOKEN = "7a2f9c14e6b8d035129af6c7e4d8b0913a5f7c2e4b19d068";
const pool = new Pool({ connectionString: process.env.NETLIFY_DATABASE_URL, ssl: { rejectUnauthorized: false } });

export default async (request) => {
  const auth = request.headers.get("authorization") || "";
  if (auth !== `Bearer ${TOKEN}`) return new Response("Unauthorized", { status: 401 });

  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `INSERT INTO event_sources (site, list_url) VALUES ($1, $2)
       ON CONFLICT (site) DO NOTHING RETURNING site, list_url`,
      ["ivsz", "https://ivsz.hu/esemenyek/"]
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
