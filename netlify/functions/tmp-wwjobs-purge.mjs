// EGYSZER HASZNÁLATOS endpoint (2026-08-25) — a LinkedIn-forrásból a
// "[ WhereWeWork Jobs ]" aggregátor-oldal alatt bekerült sorok visszamenőleges
// törlése. Hardcode-olt egyszeri token; a futtatás után TÖRLENDŐ a repóból.
//
//   GET ?token=…            → dry run: melyik cégnév hány sort érint
//   GET ?token=…&confirm=1  → törlés
import pkg from "pg";
const { Pool } = pkg;

const TOKEN = "f7268cfe20e6248ca80e60d6c324d7c0";
const pool = new Pool({
  connectionString: process.env.NETLIFY_DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// A LinkedIn-scraper normalizált (lowercase) cégnevet tárol, de a keresés
// szándékosan tág: bármi, ami "wherewework"/"where we work" néven jött be.
const MATCH = `source = 'LinkedIn' AND (
  lower(company) LIKE '%wherewework%' OR lower(company) LIKE '%where we work%'
)`;

export default async (req) => {
  const url = new URL(req.url);
  if (url.searchParams.get("token") !== TOKEN) {
    return new Response("forbidden", { status: 403 });
  }
  const confirm = url.searchParams.get("confirm") === "1";
  const client = await pool.connect();
  try {
    const before = await client.query(
      `SELECT company, count(*)::int AS n, count(*) FILTER (WHERE active)::int AS active_n
         FROM job_posts WHERE ${MATCH} GROUP BY company ORDER BY n DESC`
    );
    let deleted = 0;
    if (confirm) {
      const res = await client.query(`DELETE FROM job_posts WHERE ${MATCH}`);
      deleted = res.rowCount;
    }
    return new Response(
      JSON.stringify({ confirm, matched: before.rows, deleted }, null, 2),
      { headers: { "content-type": "application/json" } }
    );
  } finally {
    client.release();
  }
};
