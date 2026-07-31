// TEMPORARY one-off — delete 2 AI-scraped rows whose URL is a shared generic
// listing page, not a distinct per-posting URL (violates the url-is-row-
// identity rule). TIGRA (tigra.hu/aktualis/ is the site's "current openings"
// news page) and KNBSZ (the UUID URL renders ALL open roles as separate <h1>
// sections on one page). Both registered in the AI-discovery registry's
// permanentlyRejected list so the routine stops re-finding them. Delete this
// file after use.
import pkg from "pg";
const { Pool } = pkg;

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });
const ONE_OFF_TOKEN = "7d2f9a4c6e1b8305d4a7f0c3e6b9d2a5f8c1e4b7d0a3f6c9";

const URLS = [
  "https://tigra.hu/aktualis/",
  "https://www.knbsz.gov.hu/06724716-1171-4280-9c3d-dbafad5a3391",
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
      `DELETE FROM job_posts WHERE source = 'AI-scraped' AND url = ANY($1::text[]) RETURNING url, company, title`,
      [URLS]
    );
    return json(200, { deleted: res.rows });
  } finally {
    client.release();
  }
};
