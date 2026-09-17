// DISPOSABLE — 2026-09-17. GH issue #18/#24 follow-up: kuka was named in
// #18's original 9-source list but missed the 09-16 batch (cebd6b7) the same
// way otp did. Backfills existing kuka rows with company IS NULL/'' to
// "KUKA" — matches the literal cron_jobs_MIX-background.mjs's
// extractKukaJobs() now writes at insert. Delete after use.
import { Pool } from "pg";

const TOKEN = "9f11310b9f4955ff68c43ae8d853d431ea17102563db07bb";
const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });

  const dryRun = new URL(request.url).searchParams.get("dryRun") === "1";

  const client = await pool.connect();
  try {
    if (dryRun) {
      const { rows } = await client.query(
        `SELECT count(*) AS would_update FROM job_posts
          WHERE source = 'kuka' AND (company IS NULL OR company = '')`
      );
      return new Response(JSON.stringify({ dryRun, would_update: Number(rows[0].would_update) }, null, 2), {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
    const res = await client.query(
      `UPDATE job_posts SET company = 'KUKA'
        WHERE source = 'kuka' AND (company IS NULL OR company = '')`
    );
    return new Response(JSON.stringify({ dryRun, updated: res.rowCount }, null, 2), {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  } finally {
    client.release();
  }
};
