import { Pool } from "pg";

const TOKEN = "tmp-senior-check-8f2a91c7";

const pool = new Pool({
  connectionString: process.env.NETLIFY_DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

export default async (req) => {
  const auth = req.headers.get("authorization") || "";
  if (auth.replace(/^Bearer\s+/i, "").trim() !== TOKEN) {
    return new Response("unauthorized", { status: 401 });
  }

  const client = await pool.connect();
  try {
    const filters = await client.query(
      `SELECT word FROM job_filters WHERE word ~* '(^|[^a-z0-9])(senior|szenior|\\ssr\\s|sr\\.)' ORDER BY word`
    );

    const seniorRows = await client.query(
      `SELECT title, source, active, experience, first_seen
       FROM job_posts
       WHERE source LIKE 'LinkedIn%'
         AND active = true
         AND title ~* '(^|[^a-z0-9])(senior|szenior|sr\\.|sr\\s|lead|principal|staff|head of)([^a-z0-9]|$)'
       ORDER BY first_seen DESC
       LIMIT 40`
    );

    const totalLinkedInActive = await client.query(
      `SELECT COUNT(*)::int AS c FROM job_posts WHERE source LIKE 'LinkedIn%' AND active = true`
    );

    return new Response(
      JSON.stringify(
        {
          filterWordsMatchingSenior: filters.rows,
          totalLinkedInActive: totalLinkedInActive.rows[0].c,
          seniorLookingLinkedInCount: seniorRows.rowCount,
          sample: seniorRows.rows,
        },
        null,
        2
      ),
      { headers: { "Content-Type": "application/json" } }
    );
  } finally {
    client.release();
  }
};
