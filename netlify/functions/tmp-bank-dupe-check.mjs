// DISPOSABLE — 2026-09-16. Read-only check for GH issue #18: (1) has the
// company backfill for the 7 bank/1-company sources been run yet, and (2) is
// there any remaining cross-source duplicate between those sources and a big
// aggregator source. No writes. Delete after use.
import { Pool } from "pg";

const TOKEN = "c74259b35fe934e06817a7a0b86c80040c208737eea17950";
const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

const BANKS = [
  ["mbh", "%mbh%"],
  ["erste", "%erste%"],
  ["mfb", "%mfb%"],
  ["raiffeisen", "%raiffeisen%"],
  ["unicredit", "%unicredit%"],
  ["kh", "%k&h%"],
  ["kh", "%k & h%"],
  ["kh", "%kh bank%"],
  ["cg-jobstream", "%capgemini%"],
];
const BANK_SOURCES = [...new Set(BANKS.map((b) => b[0]))];

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });

  const client = await pool.connect();
  try {
    const companyStatus = await client.query(
      `SELECT source,
              count(*) AS total,
              count(*) FILTER (WHERE company IS NULL OR company = '') AS missing_company
         FROM job_posts
        WHERE source = ANY($1::text[])
        GROUP BY source
        ORDER BY source`,
      [BANK_SOURCES]
    );

    const dupeRows = [];
    for (const [source, companyLike] of BANKS) {
      const { rows } = await client.query(
        `WITH normed AS (
           SELECT id, source, company, title, url, active,
             btrim(regexp_replace(
               translate(lower(title), 'áéíóöőúüű', 'aeiooouuu'),
               '[^a-z0-9+#]+', ' ', 'g'
             )) AS norm_title
           FROM job_posts
         )
         SELECT
           small.id AS small_id, small.source AS small_source, small.company AS small_company,
           small.title AS small_title, small.url AS small_url, small.active AS small_active,
           big.id AS big_id, big.source AS big_source, big.company AS big_company,
           big.title AS big_title, big.url AS big_url, big.active AS big_active
         FROM normed small
         JOIN normed big
           ON big.norm_title = small.norm_title
          AND big.source <> ALL($3::text[])
          AND big.company ILIKE $2
         WHERE small.source = $1`,
        [source, companyLike, BANK_SOURCES]
      );
      dupeRows.push(...rows);
    }

    // de-dupe pairs found via more than one company_like pattern (kh has 3)
    const seen = new Set();
    const dupes = dupeRows.filter((r) => {
      const key = `${r.small_id}|${r.big_id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return new Response(
      JSON.stringify({ companyStatus: companyStatus.rows, dupeCount: dupes.length, dupes }, null, 2),
      { headers: { "content-type": "application/json; charset=utf-8" } }
    );
  } finally {
    client.release();
  }
};
