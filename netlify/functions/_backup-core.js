import { getStore } from "@netlify/blobs";
import { Pool } from "pg";

const STORE_NAME = "weekly-backups";

export async function runBackup(key, { returnContent = false } = {}) {
  const pool = new Pool({
    connectionString: process.env.NETLIFY_DATABASE_URL_UNPOOLED,
    ssl: { rejectUnauthorized: false },
  });

  const { rows } = await pool.query("SELECT * FROM subject_reviews");
  await pool.end();

  const store = getStore(STORE_NAME);

  const content = JSON.stringify(
    { exportedAt: new Date().toISOString(), rows },
    null,
    2
  );

  await store.set(key, content, {
    metadata: { table: "reviews" },
  });

  return returnContent ? { key, content } : { key };
}

/**
 * List blobs in the backup store.
 * Returns an array of objects like: { key, metadata, lastModified, size } (shape can vary a bit)
 */
export async function listBackups({ prefix = "" } = {}) {
  const store = getStore(STORE_NAME);

  // Netlify Blobs list API supports prefix + pagination via cursor
  const out = [];
  let cursor = undefined;

  for (;;) {
    const res = await store.list({ prefix, cursor }); // { blobs: [], cursor?: string }
    const blobs = res?.blobs || res?.items || []; // defensive (API shape can differ by runtime version)
    out.push(...blobs);

    cursor = res?.cursor;
    if (!cursor) break;
  }

  return out;
}

export async function deleteBackup(key) {
  const store = getStore(STORE_NAME);
  await store.delete(key);
  return true;
}
