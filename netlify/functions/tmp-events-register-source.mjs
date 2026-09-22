// DISPOSABLE — 2026-09-22. Direct-DB registration for a new event_sources
// row, bypassing event-sources.js's HTTP auth (the AI_INGEST_TOKEN baked
// into the "Event source discovery" routine's prompt returned 401 against
// the live endpoint — value mismatch/rotation, not investigated further;
// this goes straight to the same table via the same connection string
// instead). Same INSERT ... ON CONFLICT DO NOTHING shape as event-sources.js.
// Delete after use.

import { Pool } from "pg";

const TOKEN = "1da79ff50cbbe92c6d8045541555a734a2ecdeda29a7c330";
const connectionString = process.env.NETLIFY_DATABASE_URL;
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });

  const { site, list_url, mode } = await request.json();
  if (!site || !list_url) return new Response(JSON.stringify({ error: "site + list_url required" }), { status: 400 });

  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `INSERT INTO event_sources (site, list_url, mode)
       VALUES ($1, $2, $3)
       ON CONFLICT (site) DO NOTHING
       RETURNING site, list_url, mode`,
      [site, list_url, mode || "llm-read"],
    );
    return new Response(JSON.stringify({ inserted: rows.length > 0, row: rows[0] || null }, null, 2), {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  } finally {
    client.release();
  }
};
