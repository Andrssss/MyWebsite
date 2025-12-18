import { getStore } from "@netlify/blobs";
import { Pool } from "pg";

export async function runBackup(key) {
  const pool = new Pool({
    connectionString: process.env.NETLIFY_DATABASE_URL_UNPOOLED,
    ssl: { rejectUnauthorized: false },
  });

  const { rows } = await pool.query("SELECT * FROM reviews");
  await pool.end();

  const store = getStore("weekly-backups");

  const content = JSON.stringify(
    { exportedAt: new Date().toISOString(), rows },
    null,
    2
  );

  await store.set(key, content, {
    metadata: { table: "reviews" },
  });

  return key;
}
