// DISPOSABLE — one-off migration endpoint. Deploy, invoke once, then delete
// (and remove the [functions."tmp-migrate-stats-to-blob"] timeout override
// in netlify.toml). See CLAUDE.md "Deploy & one-off writes workflow".
//
// Full rebuild of job_daily_stats/job_daily_categories straight into the new
// "job-stats" Blob store (see _daily_stats_store.mjs), using the existing
// rebuildStats() path — same mechanism already used 3x before for in-place
// DB rebuilds, now writing to the blob instead. Reports old-table vs
// new-blob totals side by side so the migration can be eyeballed before the
// DB tables are dropped.

import pkg from "pg";
const { Pool } = pkg;
import { loadCategories } from "./load_categories.mjs";
import { rebuildStats } from "./_stats_rebuild_core.mjs";
import { readDailyStats } from "./_daily_stats_store.mjs";

const TOKEN = "c3c630a0ccae3db7cde1d03b051604b49ca247a38a9df0b6";

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

export default async (req) => {
  const auth = req.headers.get("authorization") || "";
  if (auth !== `Bearer ${TOKEN}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const client = await pool.connect();
  try {
    const { rows: oldStatsRows } = await client.query(
      `SELECT COUNT(*)::int AS days,
              COALESCE(SUM(total_jobs), 0)::int AS total,
              COALESCE(SUM(intern_jobs), 0)::int AS intern
         FROM job_daily_stats`
    );
    const { rows: oldCatRows } = await client.query(
      `SELECT COUNT(*)::int AS rows, COALESCE(SUM(count), 0)::int AS total
         FROM job_daily_categories`
    );

    const JOB_CATEGORIES = await loadCategories();
    const rebuild = await rebuildStats(client, JOB_CATEGORIES, {});

    const blob = await readDailyStats();
    const newTotal = blob.dailyStats.reduce((s, r) => s + r.total_jobs, 0);
    const newIntern = blob.dailyStats.reduce((s, r) => s + r.intern_jobs, 0);
    const newCatTotal = blob.dailyCategories.reduce((s, r) => s + r.count, 0);

    return new Response(
      JSON.stringify(
        {
          old: {
            days: oldStatsRows[0].days,
            total: oldStatsRows[0].total,
            intern: oldStatsRows[0].intern,
            catRows: oldCatRows[0].rows,
            catTotal: oldCatRows[0].total,
          },
          new: {
            days: blob.dailyStats.length,
            total: newTotal,
            intern: newIntern,
            catRows: blob.dailyCategories.length,
            catTotal: newCatTotal,
            generatedAt: blob.generatedAt,
          },
          rebuildSummary: {
            from: rebuild.from,
            to: rebuild.to,
            liveRows: rebuild.liveRows,
            archiveRows: rebuild.archiveRows,
            archiveBlobs: rebuild.archiveBlobs,
            duplicatesCollapsed: rebuild.duplicatesCollapsed,
            days: rebuild.days,
            ms: rebuild.ms,
          },
        },
        null,
        2
      ),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message, stack: err.stack }, null, 2), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  } finally {
    client.release();
  }
};
