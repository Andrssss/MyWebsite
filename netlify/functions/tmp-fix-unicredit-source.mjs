// Disposable one-off: reclassify the UniCredit "TalentCommunity" row's source
// to ai-scraped, per explicit user instruction. Delete this file after use.
import { Pool } from "pg";

const TOKEN = "7e0a67153a5697732f2c9e701798e1a8";

const connectionString = process.env.NETLIFY_DATABASE_URL;
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

export default async (req) => {
  const auth = req.headers.get("authorization") || "";
  if (auth !== `Bearer ${TOKEN}`) {
    return new Response("unauthorized", { status: 401 });
  }

  const client = await pool.connect();
  try {
    const res = await client.query(
      `UPDATE job_posts SET source = 'ai-scraped'
       WHERE url = 'https://careers.unicredit.eu/hu_HU/jobsuche/TalentCommunity'
       RETURNING id, source, title, url, active`
    );
    return new Response(JSON.stringify(res.rows), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } finally {
    client.release();
  }
};
