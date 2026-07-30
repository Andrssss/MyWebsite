// TEMPORARY one-off — retroactively fix the "graduate" title mislabel bug
// (INTERNSHIP_KEYWORDS wrongly included "graduate" -> diákmunka; fixed in
// _experience_core.mjs 2026-07-30, moved to JUNIOR_KEYWORDS). The anti-clobber
// upsert never overwrites an already-set experience value on re-scrape, so
// existing affected rows need a direct fix. Scoped to the exact URLs found via
// a live jobs-API scan (title contains "graduate", experience = 'diákmunka').
// Delete after use.
import pkg from "pg";
const { Pool } = pkg;

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });
const ONE_OFF_TOKEN = "b3f8d1a6c9e42057b1d8a3f6c0e9b7d4a2f5c8e1b6d3a9f7";

const URLS = [
  "https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/Formal-Verification-Engineer---New-College-Graduate_JR2008771",
  "https://hu.alllocaljobs.com/%C3%A1ll%C3%A1s-6AtD7P1Rd",
  "https://hu.alllocaljobs.com/%C3%A1ll%C3%A1s-GZtbGRae5",
  "https://hu.linkedin.com/jobs/view/data-abstraction-analyst-emea-grade-graduate-at-cushman-wakefield-4436767968?position=58&pageNum=0&refId=CZ0ShvAiH9tl595yExx4iw%3D%3D&trackingId=GjAHfxiemmUQF9V0xNIADQ%3D%3D",
];

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
      `UPDATE job_posts SET experience = 'junior'
       WHERE url = ANY($1::text[]) AND experience = 'diákmunka'
       RETURNING url, source, experience`,
      [URLS]
    );
    return json(200, { updated: res.rows });
  } finally {
    client.release();
  }
};
