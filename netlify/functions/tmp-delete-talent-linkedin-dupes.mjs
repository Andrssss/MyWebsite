// TEMPORARY one-off — 2026-08-04 user-döntés: talent.com sorok törlése azoknál
// a cégeknél, ahol a talent-hirdetések cím szerint 100%-ban duplikálják a
// LinkedIn-hirdetéseket (lásd _company_blocklist.mjs TALENT_ONLY_COMPANY_BLOCKLIST,
// ugyanez a lista már megakadályozza az újrainsertelést). Delete after use.
import pkg from "pg";
const { Pool } = pkg;

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });
const ONE_OFF_TOKEN = "ef0508b07fb49ab19d377f1e383af82a77caeb65b22d2d10";

const COMPANIES = [
  "Ecolab",
  "Hiflylabs",
  "Kpler",
  "Nexperia",
  "OnTheGoSystems",
  "Pixel Systems",
  "Schneider Electric",
  "Siemens",
  "Unisys",
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

  const url = new URL(request.url);
  const client = await pool.connect();
  try {
    if (url.searchParams.get("mode") === "diag") {
      const like = COMPANIES.map((c) => `%${c.toLowerCase()}%`);
      const res = await client.query(
        `SELECT company, title, url, encode(company::bytea, 'hex') AS hex, length(company) AS len
         FROM job_posts
         WHERE source = 'talent' AND lower(company) LIKE ANY($1::text[])`,
        [like]
      );
      return json(200, { count: res.rows.length, rows: res.rows });
    }

    const res = await client.query(
      `DELETE FROM job_posts
       WHERE source = 'talent' AND trim(company) = ANY($1::text[])
       RETURNING company, title, url`,
      [COMPANIES]
    );
    return json(200, { deletedCount: res.rows.length, deleted: res.rows });
  } finally {
    client.release();
  }
};
