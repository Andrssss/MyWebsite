import { Pool } from "pg";

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

let cache = null;
let cacheTs = 0;
const TTL = 5 * 60 * 1000; // 5 perc

export async function loadFilters() {
  const now = Date.now();
  if (cache && now - cacheTs < TTL) return cache;

  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT word FROM job_filters ORDER BY word`
    );
    const result = rows.map(r => r.word);
    cache = result;
    cacheTs = now;
    return result;
  } finally {
    client.release();
  }
}
