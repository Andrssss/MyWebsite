// DISPOSABLE — 2026-09-16. One-off full rebuild of the "job-stats" blob so
// dailyLanguages/dailyTechnologies (added earlier today — see _stats_core.mjs's
// technologyBreakdown()) get backfilled across the existing history instead of
// only appearing on days from today onward. Just calls the already-existing
// _stats_rebuild_core.mjs rebuildStats() with no date range (a full rebuild —
// this also recomputes dailyStats/dailyCategories, which is a no-op change
// under the current category rules, same as any other full rebuild).
// Writes a report to the "tmp-langtech-backfill-result" Blob (read via the
// -result.mjs sibling, since a background function can't return a body to
// its invoker). Delete this file and its -result.mjs sibling after use.
import { Pool } from "pg";
import { getStore } from "@netlify/blobs";
import { withTimeout } from "./_error-logger.mjs";
import { loadCategories } from "./load_categories.mjs";
import { rebuildStats } from "./_stats_rebuild_core.mjs";

const TOKEN = "556d087dd508de399bd2bb8e5a24f1a78a724d34";

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

export default withTimeout("tmp-langtech-backfill-background", async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });

  const store = getStore("tmp-langtech-backfill-result");
  const client = await pool.connect();
  try {
    const jobCategories = await loadCategories();
    const result = await rebuildStats(client, jobCategories, {});
    await store.setJSON("latest.json", { finishedAt: new Date().toISOString(), ...result });
    return new Response("done", { status: 200 });
  } catch (err) {
    await store.setJSON("latest.json", {
      finishedAt: new Date().toISOString(),
      error: String(err?.message || err),
    });
    throw err;
  } finally {
    client.release();
  }
});
