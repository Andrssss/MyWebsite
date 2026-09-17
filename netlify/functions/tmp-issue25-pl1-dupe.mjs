// DISPOSABLE — 2026-09-17. GH issue #25 manual-review cleanup: the one
// confirmed genuine duplicate out of the ~11 disputed pairs (talent.com "PL1
// Developer" @ Allianz Technology, two /view?id= urls for the verbatim same
// posting — talent's id is a per-fetch tracking id, not a stable job id, see
// migrateByTitleCompany's doc in _active_core.mjs). This case slipped past
// that same-source dedup because its two fetches extracted different (both
// wrong) `technologies` — the real stack (PL1/DB2/WebSphere MQ) has no
// recognized keywords, so migrateByTitleCompany's required exact-tech-match
// safety net never fired. GET reports both rows so the older one can be kept
// deliberately; POST {"action":"delete","id":N} removes one by primary key.
// Delete this file after use.
import { Pool } from "pg";

const TOKEN = "2f97b0a35a7d9a00b460d553e363db776a6f1791f041eed5";
const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

const URLS = [
  "https://hu.talent.com/view?id=549603485004729655",
  "https://hu.talent.com/view?id=610222443064860511",
];

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });

  const client = await pool.connect();
  try {
    if (request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      if (body.action !== "delete" || !Number.isInteger(body.id)) {
        return new Response(JSON.stringify({ error: "expected {action:'delete', id:<int>}" }), {
          status: 400,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
      const { rows } = await client.query(`SELECT id, url, source FROM job_posts WHERE id = $1`, [body.id]);
      if (rows.length === 0 || rows[0].source !== "talent" || !URLS.includes(rows[0].url)) {
        return new Response(JSON.stringify({ error: "refusing: id not one of the expected talent rows", rows }), {
          status: 400,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
      const { rowCount } = await client.query(`DELETE FROM job_posts WHERE id = $1`, [body.id]);
      return new Response(JSON.stringify({ deleted: rowCount, id: body.id }), {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    const { rows } = await client.query(
      `SELECT id, url, title, company, technologies, active, sweep_dead, first_seen, last_seen
         FROM job_posts WHERE source = 'talent' AND url = ANY($1::text[])`,
      [URLS]
    );
    return new Response(JSON.stringify({ rows }, null, 2), {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  } finally {
    client.release();
  }
};
