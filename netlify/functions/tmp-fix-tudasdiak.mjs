import pkg from "pg";
const { Pool } = pkg;

const connectionString = process.env.NETLIFY_DATABASE_URL;
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

const FIXES = [
  {
    old: "https://app.tudatosdiak.hu/hu/jobs/szoftver-tesztelo-diakmunka/9774726145",
    fixed: "https://app.tudatosdiak.hu/hu/jobs/szoftver-tesztelo-diakmunka/pj9774726145",
  },
  {
    old: "https://app.tudatosdiak.hu/hu/jobs/security-support-engineering-intern-iam/8730955343",
    fixed: "https://app.tudatosdiak.hu/hu/jobs/security-support-engineering-intern-iam/pj8730955343",
  },
];

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!process.env.CRON_SECRET || token !== process.env.CRON_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  const client = await pool.connect();
  const result = [];
  try {
    for (const f of FIXES) {
      const { rows: dupe } = await client.query(`SELECT 1 FROM job_posts WHERE url = $1`, [f.fixed]);
      if (dupe.length) {
        result.push({ old: f.old, fixed: f.fixed, action: "skipped (target already exists)" });
        continue;
      }
      const res = await client.query(
        `UPDATE job_posts SET url = $1 WHERE url = $2 AND source = 'tudasdiak'`,
        [f.fixed, f.old]
      );
      result.push({ old: f.old, fixed: f.fixed, rowCount: res.rowCount });
    }
  } finally {
    client.release();
  }

  return new Response(JSON.stringify(result, null, 2), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
