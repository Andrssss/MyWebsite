// netlify/functions/fix-job-field.js
//
// One-off admin correction endpoint: directly overwrite job_posts fields for a
// single row by url, bypassing the anti-clobber guard every ingest path uses
// (upsertJob in _ai_ingest_core.mjs only overwrites experience when the
// existing value is NULL/'-'/''). That guard is correct for routine re-scrapes
// but means a wrong value already written (e.g. a bad AI-pipeline judgment
// call) can't be fixed by resubmitting through ai-registry/ai-ingest — this
// exists so a bad row can be corrected via the API instead of needing raw DB
// creds for a manual SQL UPDATE (see [[ai-scraped-pipeline]] memory,
// 2026-07-21 "medior" mislabel; 2026-07-22 added `active` to deactivate
// AI-scraped duplicates of an already-hand-scraped source, e.g. nix).
//
//   curl -X POST https://bakan7.netlify.app/.netlify/functions/fix-job-field \
//     -H "Authorization: Bearer $CRON_SECRET" -H "Content-Type: application/json" \
//     -d '{"url":"https://example.hu/allas/1","experience":"junior"}'
//     -d '{"url":"https://example.hu/allas/1","active":false}'

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
  const source = typeof payload.source === "string" ? payload.source.trim() : "";
  const experience = typeof payload.experience === "string" ? payload.experience.trim() : "";
  const hasActive = typeof payload.active === "boolean";
  if (!url || (!experience && !hasActive)) {
    return json(400, { error: "'url' plus at least one of 'experience'/'active' are required" });
  }

  // `url` alone is NOT a unique row key — (source, url) is (ON CONFLICT
  // (source, url) in every upsert). The same url can legitimately exist under
  // two different sources at once (2026-07-22: nixstech.com scraped by both
  // the hand-written `nix` cron AND, by mistake, the AI pipeline under
  // `AI-scraped`) — matching on url only would silently update BOTH rows.
  // Require `source` whenever more than one row shares the url.
  const sets = [];
  const values = [url];
  if (experience) { values.push(experience); sets.push(`experience = $${values.length}`); }
  if (hasActive) { values.push(payload.active); sets.push(`active = $${values.length}`); }

  const client = await pool.connect();
  try {
    const { rows: matches } = await client.query(
      `SELECT id, source FROM job_posts WHERE url = $1`, [url]
    );
    if (matches.length > 1 && !source) {
      return json(409, {
        error: "Multiple rows share this url — pass 'source' to disambiguate",
        sources: matches.map((m) => m.source),
      });
    }

    const whereClause = source ? `url = $1 AND source = $${values.length + 1}` : `url = $1`;
    if (source) values.push(source);

    const { rowCount, rows } = await client.query(
      `UPDATE job_posts SET ${sets.join(", ")} WHERE ${whereClause}
       RETURNING id, source, title, experience, active`,
      values
    );
    if (!rowCount) return json(404, { error: "No job_posts row matches that url/source" });
    return json(200, { ok: true, updated: rows[0] });
  } finally {
    client.release();
  }
};
