// TEMPORARY one-off — undo the accidental re-insert of the KNBSZ row. A fix
// attempt using #fragment-anchored URLs for 5 distinct KNBSZ postings got
// silently collapsed by normalizeUrl() (strips URL fragments) back into one
// row under the same base URL that was already deleted once. KNBSZ is
// structurally unfixable in this pipeline (see ai-registry permanentlyRejected
// entry added 2026-07-31) — delete it again and leave it rejected. Delete this
// file after use.
import pkg from "pg";
const { Pool } = pkg;

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });
const ONE_OFF_TOKEN = "4a8f1c6d9b2e5073a6d9b2c5e8f1a4d7c0b3e6f9a2d5c8b1";
const URL_TO_KILL = "https://www.knbsz.gov.hu/06724716-1171-4280-9c3d-dbafad5a3391";

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export default async (request) => {
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (token !== ONE_OFF_TOKEN) return json(401, { error: "Unauthorized" });

  const client = await pool.connect();
  try {
    const res = await client.query(
      `DELETE FROM job_posts WHERE source = 'AI-scraped' AND url = $1 RETURNING url, company, title`,
      [URL_TO_KILL]
    );
    return json(200, { deleted: res.rows });
  } finally {
    client.release();
  }
};
