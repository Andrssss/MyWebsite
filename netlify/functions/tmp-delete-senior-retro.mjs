// TEMPORARY one-off — retroactively deletes job_posts rows whose experience is
// senior-flagged (isSeniorExperience, _experience_core.mjs).
// User request 2026-09-04: STORE_SENIOR_JOBS flipped back to false (kill switch),
// this cleans up what already sat in the DB from the 2026-08-25..09-04 window
// when it was true. Unlike the 2026-08-01 cleanup (tmp-delete-nonlinkedin-senior,
// deleted, commit a8a6c93/ef0a18a), LinkedIn is NOT excluded this time — since
// then _linkedin_core.mjs also runs through _seniority_policy.mjs the same as
// every other source.
// GET ?dryrun=1 previews (scanned/matched/bySource) without deleting.
// Delete this file after use.
import pkg from "pg";
const { Pool } = pkg;
import { isSeniorExperience } from "./_experience_core.mjs";

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });
const ONE_OFF_TOKEN = "b71f4c9a03e6d8215fa47c0e91b3d6a852f13c907e4a6b8d";

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export default async (request) => {
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (token !== ONE_OFF_TOKEN) return json(401, { error: "Unauthorized" });

  const url = new URL(request.url);
  const dryRun = url.searchParams.get("dryrun") === "1";

  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT id, source, title, url, experience FROM job_posts`
    );
    const senior = rows.filter((r) => isSeniorExperience(r.experience));
    const bySource = {};
    for (const r of senior) bySource[r.source] = (bySource[r.source] || 0) + 1;

    if (dryRun) {
      return json(200, {
        dryRun: true,
        scanned: rows.length,
        matched: senior.length,
        bySource,
        sample: senior.slice(0, 80).map((r) => ({ source: r.source, title: r.title, experience: r.experience, url: r.url })),
      });
    }

    const ids = senior.map((r) => r.id);
    const { rows: deleted } = await client.query(
      `DELETE FROM job_posts WHERE id = ANY($1) RETURNING id, source, title, url`,
      [ids]
    );

    return json(200, {
      dryRun: false,
      scanned: rows.length,
      matched: senior.length,
      deleted: deleted.length,
      bySource,
    });
  } finally {
    client.release();
  }
};
