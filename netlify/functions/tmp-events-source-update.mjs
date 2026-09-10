// Disposable one-off endpoint — flips kibernaptar to jsonld mode and drops
// ivsz/mvisz (no structured data, not "simple" per user request). Deploy,
// invoke once, then delete this file.
import { Pool } from "pg";

const TOKEN = "d47a1e9c6b3f0825928d4c1a7e6b309f83c5e1a";
const pool = new Pool({ connectionString: process.env.NETLIFY_DATABASE_URL, ssl: { rejectUnauthorized: false } });

export default async (request) => {
  const auth = request.headers.get("authorization") || "";
  if (auth !== `Bearer ${TOKEN}`) return new Response("Unauthorized", { status: 401 });

  const client = await pool.connect();
  try {
    await client.query(`UPDATE event_sources SET mode = 'jsonld' WHERE site = 'kibernaptar'`);
    await client.query(`DELETE FROM event_sources WHERE site IN ('ivsz', 'mvisz')`);
    const all = await client.query(`SELECT site, list_url, mode FROM event_sources ORDER BY site`);
    return new Response(JSON.stringify({ all: all.rows }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } finally {
    client.release();
  }
};
