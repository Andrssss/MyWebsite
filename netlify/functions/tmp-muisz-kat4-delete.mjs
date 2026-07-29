// TEMPORARY one-off endpoint — deletes the 9 job_posts rows that came in from
// muisz.hu category 4 (Mérnöki) during the brief window it was enabled
// (2026-07-29 17:54–18:43 local), before being reverted the same day. That
// category turned out to be dominated by non-IT engineering internships
// (mechanical/civil/electrical), not the missed IT postings the coverage
// audit was chasing. One-off token, same precedent as tmp-onefix /
// tmp-talent-tech-resweep. Delete this file after use.
import pkg from "pg";
const { Pool } = pkg;

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });
const ONE_OFF_TOKEN = "f04c7c5263544a7b6ecff5f4611996036976899d58cf3b06";

const URLS = [
  "https://muisz.hu/hu/diakmunkaink/tervezoszoftverek-bemutatasa-budapest-iii-kerulet--26538",
  "https://muisz.hu/hu/diakmunkaink/labor-feladatok-budapest-iv-kerulet--10317",
  "https://muisz.hu/hu/diakmunkaink/kozmu-szakiranyos-epitomernok-gyakornok-budapest-xi-kerulet--28573",
  "https://muisz.hu/hu/diakmunkaink/fdm-gyakornok-budapest-23-ker--27386",
  "https://muisz.hu/hu/diakmunkaink/optikai-fejlesztomernok-budapest-8-ker--28484",
  "https://muisz.hu/hu/diakmunkaink/Nagyfeszultsegu-berend-ertekesito-gyakornok-budapest-xiii-kerulet--27929",
  "https://muisz.hu/hu/diakmunkaink/dokumentacios-mernok-gyakornok-budapest-23-ker--28268",
  "https://muisz.hu/hu/diakmunkaink/termekfejleszto-mernok-gyakornok-budapest-23-ker--28830",
  "https://muisz.hu/hu/diakmunkaink/mernoksegi-gyakornok-budapest-10-ker--28841",
];

export default async (request) => {
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (token !== ONE_OFF_TOKEN) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `DELETE FROM job_posts WHERE source = 'muisz' AND url = ANY($1) RETURNING id, title, url`,
      [URLS]
    );
    return new Response(
      JSON.stringify({ ok: true, requested: URLS.length, deleted: rows.length, rows }),
      { status: 200, headers: { "Content-Type": "application/json; charset=utf-8" } }
    );
  } finally {
    client.release();
  }
};
