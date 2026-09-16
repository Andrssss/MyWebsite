// DISPOSABLE — 2026-09-16. Read-only probe to size the job_posts history
// before chunking the langtech backfill rebuild into date ranges that fit
// inside the 14-min background-function budget (the unbounded full-history
// call in tmp-langtech-backfill-background.mjs never finished). Delete
// alongside the backfill endpoint and its result reader once the backfill
// is confirmed done.
import { Pool } from "pg";
import { getStore } from "@netlify/blobs";

const TOKEN = "556d087dd508de399bd2bb8e5a24f1a78a724d34";

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });

  const client = await pool.connect();
  let dbInfo;
  try {
    const { rows } = await client.query(
      `SELECT MIN((first_seen AT TIME ZONE 'UTC')::date) AS min_day,
              MAX((first_seen AT TIME ZONE 'UTC')::date) AS max_day,
              COUNT(*)::int AS total
         FROM job_posts`
    );
    dbInfo = rows[0];
  } finally {
    client.release();
  }

  const store = getStore("job-posts-archive");
  const { blobs } = await store.list();

  const statsStore = getStore("job-stats");
  const stats = await statsStore.get("latest.json", { type: "json" });
  const dailyLanguages = stats?.dailyLanguages || [];
  const dailyTechnologies = stats?.dailyTechnologies || [];
  const statsSummary = {
    generatedAt: stats?.generatedAt,
    dailyStatsCount: (stats?.dailyStats || []).length,
    dailyLanguagesCount: dailyLanguages.length,
    dailyTechnologiesCount: dailyTechnologies.length,
    dailyLanguagesDateRange: dailyLanguages.length
      ? [dailyLanguages[0].date, dailyLanguages[dailyLanguages.length - 1].date]
      : null,
    dailyTechnologiesDateRange: dailyTechnologies.length
      ? [dailyTechnologies[0].date, dailyTechnologies[dailyTechnologies.length - 1].date]
      : null,
    earliestLanguageSample: dailyLanguages.slice(0, 5),
    earliestTechnologySample: dailyTechnologies.slice(0, 5),
  };

  return new Response(
    JSON.stringify(
      { dbInfo, archiveBlobCount: blobs.length, archiveBlobKeys: blobs.map((b) => b.key), statsSummary },
      null,
      2
    ),
    { headers: { "content-type": "application/json; charset=utf-8" } }
  );
};
