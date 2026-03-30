import pkg from "pg";
const { Pool } = pkg;

export const config = {
  // pl. minden nap 01:30 UTC
  schedule: "10 1 * * 1",
};

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

export default async () => {
  const client = await pool.connect();
  try {
    // 30 napnál régebbiek törlése first_seen alapján
    const { rowCount } = await client.query(`
      DELETE FROM job_posts
      WHERE first_seen < (NOW() - INTERVAL '60 days')
    `);

    return new Response(`cleanup OK: deleted ${rowCount}`, { status: 200 });
  } catch (err) {
    console.error(err);
    return new Response("cleanup failed", { status: 500 });
  } finally {
    client.release();
  }
};
