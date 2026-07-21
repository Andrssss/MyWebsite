// netlify/functions/fix-job-field.js
//
// One-off admin correction endpoint: directly overwrite job_posts.experience
// for a single row by url, bypassing the anti-clobber guard every ingest path
// uses (upsertJob in _ai_ingest_core.mjs only overwrites experience when the
// existing value is NULL/'-'/''). That guard is correct for routine re-scrapes
// but means a wrong value already written (e.g. a bad AI-pipeline judgment
// call) can't be fixed by resubmitting through ai-registry/ai-ingest — this
// exists so a bad row can be corrected via the API instead of needing raw DB
// creds for a manual SQL UPDATE (see [[ai-scraped-pipeline]] memory,
// 2026-07-21 "medior" mislabel).
//
//   curl -X POST https://bakan7.netlify.app/.netlify/functions/fix-job-field \
//     -H "Authorization: Bearer $CRON_SECRET" -H "Content-Type: application/json" \
//     -d '{"url":"https://example.hu/allas/1","experience":"junior"}'

import { Pool } from "pg";

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function authorized(request) {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  return token === expected;
}

export default async (request) => {
  if (!authorized(request)) return json(401, { error: "Unauthorized" });
  if (request.method !== "POST") return json(405, { error: "POST only" });

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  const url = typeof payload.url === "string" ? payload.url.trim() : "";
  const experience = typeof payload.experience === "string" ? payload.experience.trim() : "";
  if (!url || !experience) return json(400, { error: "Both 'url' and 'experience' are required" });

  const client = await pool.connect();
  try {
    const { rowCount, rows } = await client.query(
      `UPDATE job_posts SET experience = $1 WHERE url = $2 RETURNING id, source, title, experience`,
      [experience, url]
    );
    if (!rowCount) return json(404, { error: "No job_posts row matches that url" });
    return json(200, { ok: true, updated: rows[0] });
  } finally {
    client.release();
  }
};
