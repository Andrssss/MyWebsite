/*
  DISPOSABLE read/write DB endpoint — delete after use.
  Created 2026-08-27 to diagnose three reported active-flag bugs
  (schonherz Voice Agent, startup.jobs closed postings, tudasdiak stale rows).
  Token is hardcoded on purpose: single-use, removed in the same session.
*/
import { Pool } from "pg";

const TOKEN = "aea52675b9e53c3476c551538363a4bf9023df44cf216980";
const pool = new Pool({
  connectionString: process.env.NETLIFY_DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

export default async (req) => {
  const url = new URL(req.url);
  if (url.searchParams.get("t") !== TOKEN) return new Response("nope", { status: 403 });

  let body;
  try { body = await req.json(); } catch { return new Response("bad json", { status: 400 }); }

  // probe mode: authenticated GET against api.startup.jobs, to find out what a
  // CLOSED posting looks like through the official API (the HTML page is behind
  // Cloudflare and 403s the sweep).
  if (body.probe) {
    const out = [];
    for (const u of body.probe) {
      try {
        const r = await fetch(u, {
          headers: {
            Authorization: `Bearer ${process.env.STARTUPJOBS_API_KEY}`,
            Accept: "application/json",
          },
        });
        const t = await r.text();
        out.push({ url: u, status: r.status, body: t.slice(0, 1500) });
      } catch (e) {
        out.push({ url: u, error: e.message });
      }
    }
    return new Response(JSON.stringify(out), { headers: { "content-type": "application/json" } });
  }

  const queries = Array.isArray(body.queries) ? body.queries : [{ sql: body.sql, params: body.params || [] }];

  const client = await pool.connect();
  const out = [];
  try {
    for (const q of queries) {
      const r = await client.query(q.sql, q.params || []);
      out.push({ command: r.command, rowCount: r.rowCount, rows: r.rows });
    }
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message, out }), { status: 500, headers: { "content-type": "application/json" } });
  } finally {
    client.release();
  }
  return new Response(JSON.stringify(out), { headers: { "content-type": "application/json" } });
};
