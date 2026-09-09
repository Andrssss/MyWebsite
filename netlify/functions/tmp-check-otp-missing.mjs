import { Pool } from "pg";

const TOKEN = "tmp-otp-missing-9a41cf03";

const pool = new Pool({
  connectionString: process.env.NETLIFY_DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

function normalizeFilterWord(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function filterRegex(word) {
  const key = normalizeFilterWord(word);
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i");
}

export default async (req) => {
  const auth = req.headers.get("authorization") || "";
  if (auth.replace(/^Bearer\s+/i, "").trim() !== TOKEN) {
    return new Response("unauthorized", { status: 401 });
  }

  const client = await pool.connect();
  try {
    const byReqId = await client.query(
      `SELECT id, source, title, url, experience, active, company, first_seen, last_seen, sweep_dead
       FROM job_posts WHERE url LIKE '%1434343033%'`
    );
    const byTitle = await client.query(
      `SELECT id, source, title, url, experience, active, company, first_seen, last_seen
       FROM job_posts WHERE title ILIKE '%tesztautomatiz%' ORDER BY first_seen DESC LIMIT 30`
    );

    const filters = (await client.query(`SELECT word FROM job_filters ORDER BY word`)).rows.map((r) => r.word);
    const title = "Tesztautomatizáló gyakornok";
    const matches = filters.filter((w) => filterRegex(w).test(normalizeFilterWord(title)));

    const otpRecent = await client.query(
      `SELECT id, title, url, experience, active, first_seen
       FROM job_posts WHERE source = 'otp' ORDER BY first_seen DESC LIMIT 15`
    );

    const otpCount = await client.query(
      `SELECT COUNT(*)::int AS c, MAX(first_seen) AS latest FROM job_posts WHERE source = 'otp'`
    );

    return new Response(
      JSON.stringify(
        {
          byReqId: byReqId.rows,
          byTitle: byTitle.rows,
          titleFilterMatches: matches,
          otpRecent: otpRecent.rows,
          otpCount: otpCount.rows[0],
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
