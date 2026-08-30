/*
  DISPOSABLE read-only DB endpoint — delete after use.
  Created 2026-08-30 to analyse ats-crawl coverage (ats_tenants /
  ats_slug_candidates / job_posts ats-crawl rows).
  Token is hardcoded on purpose: single-use, removed in the same session.
*/
import { Pool } from "pg";

const TOKEN = "fe1ad012bbbe8367074cab4ad12520379eb942bf2320f8d2";
const pool = new Pool({
  connectionString: process.env.NETLIFY_DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

export default async (req) => {
  const url = new URL(req.url);
  if (url.searchParams.get("t") !== TOKEN) return new Response("nope", { status: 403 });

  let body;
  try { body = await req.json(); } catch { return new Response("bad json", { status: 400 }); }

  const queries = Array.isArray(body.queries) ? body.queries : [{ sql: body.sql, params: body.params || [] }];
  for (const q of queries) {
    if (!/^\s*select\b/i.test(q.sql || "")) {
      return new Response(JSON.stringify({ error: "read-only endpoint" }), { status: 400 });
    }
  }

  const client = await pool.connect();
  const out = [];
  try {
    for (const q of queries) {
      const r = await client.query(q.sql, q.params || []);
      out.push({ rowCount: r.rowCount, rows: r.rows });
    }
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message, out }), { status: 500, headers: { "content-type": "application/json" } });
  } finally {
    client.release();
  }
  return new Response(JSON.stringify(out), { headers: { "content-type": "application/json" } });
};
