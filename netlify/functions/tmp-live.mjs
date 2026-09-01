/*
  DISPOSABLE endpoint — delete after use.
  Created 2026-09-01 for the manual AI-scraped / ats-crawl liveness pass:
  lists the active rows of both buckets, and deactivates an explicit url list
  the same way the daily sweep does (active=false + sweep_dead=true, so
  reviveSweepDead can undo a false kill).
  Token hardcoded on purpose: single-use, removed in the same session.
*/
import { Pool } from "pg";

const TOKEN = "b7c1e9a4f2d84c0f9a3e5b6712fd0a8c4e7b19d3";
const SOURCES = ["AI-scraped", "ats-crawl"];

const pool = new Pool({
  connectionString: process.env.NETLIFY_DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

export default async (req) => {
  const url = new URL(req.url);
  if (url.searchParams.get("t") !== TOKEN) return new Response("nope", { status: 403 });
  const action = url.searchParams.get("action") || "list";
  const client = await pool.connect();
  try {
    if (action === "list") {
      const r = await client.query(
        `SELECT url, source, title, company, first_seen, sweep_dead
           FROM job_posts
          WHERE active = true AND source = ANY($1::text[])
          ORDER BY source, first_seen`,
        [SOURCES]
      );
      return json({ rowCount: r.rowCount, rows: r.rows });
    }
    if (action === "query") {
      const body = await req.json();
      if (!/^\s*select\b/i.test(body.sql || "")) return json({ error: "read-only" }, 400);
      const r = await client.query(body.sql, body.params || []);
      return json({ rowCount: r.rowCount, rows: r.rows });
    }
    if (action === "deactivate") {
      const body = await req.json();
      const src = body.source;
      const urls = Array.isArray(body.urls) ? body.urls : [];
      if (!SOURCES.includes(src)) return json({ error: "source not allowed" }, 400);
      if (!urls.length) return json({ error: "no urls" }, 400);
      const r = await client.query(
        `UPDATE job_posts SET active = false, sweep_dead = true
          WHERE active = true AND source = $2 AND url = ANY($1::text[])`,
        [urls, src]
      );
      return json({ requested: urls.length, updated: r.rowCount });
    }
    return json({ error: "unknown action" }, 400);
  } catch (e) {
    return json({ error: e.message }, 500);
  } finally {
    client.release();
  }
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}
