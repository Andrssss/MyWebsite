import pkg from "pg";
const { Pool } = pkg;

// export const config = {
//   // pl. minden nap 01:30 UTC
//   schedule: "10 1 * * 1",
// };

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

export default async (request) => {
  const expected = process.env.CRON_SECRET;
  const authHeader = (request?.headers?.get?.("authorization") || "").trim();
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!expected || token !== expected) {
    return new Response("Unauthorized", { status: 401 });
  }

  const client = await pool.connect();
  try {
    // LinkedIn: 60 nap, többi: 30 nap
    const { rowCount: linkedinCount } = await client.query(`
      DELETE FROM job_posts
      WHERE source = 'LinkedIn'
        AND first_seen < (NOW() - INTERVAL '20 days')
    `);

    const { rowCount: otherCount } = await client.query(`
      DELETE FROM job_posts
      WHERE source != 'LinkedIn'
        AND first_seen < (NOW() - INTERVAL '20 days')
    `);

    return new Response(`cleanup OK: deleted ${linkedinCount + otherCount} (LinkedIn: ${linkedinCount}, other: ${otherCount})`, { status: 200 });
  } catch (err) {
    console.error(err);
    return new Response("cleanup failed", { status: 500 });
  } finally {
    client.release();
  }
};
