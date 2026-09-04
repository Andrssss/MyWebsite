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

    // Rows where the EXTRACTED experience text implies senior (>=5 years or a
    // senior/lead/etc keyword in the experience string itself) regardless of
    // title wording — this is what shouldSkipSeniorExperience(isSeniorExperience(experience))
    // catches on every other source but LinkedIn never calls at all.
    const yearsSeniorRows = await client.query(
      `SELECT title, experience, first_seen
       FROM job_posts
       WHERE source LIKE 'LinkedIn%'
         AND active = true
         AND experience ~* '\\d+'
       ORDER BY first_seen DESC
       LIMIT 500`
    );

    const totalLinkedInActive = await client.query(
      `SELECT COUNT(*)::int AS c FROM job_posts WHERE source LIKE 'LinkedIn%' AND active = true`
    );

    function isSeniorExperience(experience) {
      const n = String(experience ?? "").toLowerCase();
      if (/\b(senior|szenior|lead|head|principal|staff|chief|director|vp|vice president)\b/.test(n)) return true;
      const nums = n.match(/\d+/g);
      if (!nums) return false;
      return Math.min(...nums.map((x) => parseInt(x, 10))) >= 5;
    }

    const yearsSenior = yearsSeniorRows.rows.filter((r) => isSeniorExperience(r.experience));

    return new Response(
      JSON.stringify(
        {
          filterWordsMatchingSenior: filters.rows,
          totalLinkedInActive: totalLinkedInActive.rows[0].c,
          seniorLookingLinkedInCount: seniorRows.rowCount,
          sample: seniorRows.rows,
          yearsBasedSeniorCount: yearsSenior.length,
          yearsBasedSample: yearsSenior.slice(0, 25),
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
