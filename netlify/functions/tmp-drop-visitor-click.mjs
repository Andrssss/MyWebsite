import { Pool } from "pg";

const TOKEN = "tmp-drop-vc-4b7e19fa";

const pool = new Pool({
  connectionString: process.env.NETLIFY_DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

export default async (req) => {
  const auth = req.headers.get("authorization") || "";
  if (auth.replace(/^Bearer\s+/i, "").trim() !== TOKEN) {
    return new Response("unauthorized", { status: 401 });
  }

  const client = await pool.connect();
  try {
    const before = await client.query(
      `SELECT COUNT(*)::int AS c FROM visitor_click_dates`
    );
    await client.query(`DROP TABLE IF EXISTS visitor_click_dates`);
    return new Response(
      JSON.stringify({ droppedRowCount: before.rows[0].c }, null, 2),
      { headers: { "Content-Type": "application/json" } }
    );
  } finally {
    client.release();
  }
};
