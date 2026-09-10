// Disposable one-off endpoint — registers "mvisz" as a recurring event_sources
// listing page. Deploy, invoke once, then delete this file.
import { Pool } from "pg";

const TOKEN = "f3d81c6a9e2b47105938af6c7e4d8b0913a5f7c2e4b19d09f";
const pool = new Pool({ connectionString: process.env.NETLIFY_DATABASE_URL, ssl: { rejectUnauthorized: false } });

export default async (request) => {
  const auth = request.headers.get("authorization") || "";
  if (auth !== `Bearer ${TOKEN}`) return new Response("Unauthorized", { status: 401 });

  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `INSERT INTO event_sources (site, list_url) VALUES ($1, $2)
       ON CONFLICT (site) DO NOTHING RETURNING site, list_url`,
      ["mvisz", "https://mvisz.hu/rendezvenyek/"]
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
