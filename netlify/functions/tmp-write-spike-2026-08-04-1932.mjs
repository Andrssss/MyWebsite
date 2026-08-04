// TEMP diagnostic — investigating the Aug 4, 2026 7:32:23pm local Neon "Rows"
// spike (Deleted:15, Updated:119, Inserted:15). Combines:
//   1) live pg_stat_user_tables snapshot (ground truth: counts every row-level
//      write regardless of which client/code path caused it)
//   2) db-write-audit blob window search around the spike, both plausible
//      timezone readings, widened to the full UTC day as a fallback.
// Disposable — delete after use.
import pkg from "pg";
const { Pool } = pkg;
import { getStore } from "@netlify/blobs";

const connectionString = process.env.NETLIFY_DATABASE_URL;
const pool = connectionString ? new Pool({ connectionString, ssl: { rejectUnauthorized: false } }) : null;
const TOKEN = "0e26195ce9f43fe81cdcd1c6c50f780ff24ac4ac450f1588";
const STORE_NAME = "db-write-audit";

function json(status, body) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

async function windowTotals(store, keys, sinceIso, untilIso) {
  const sinceKey = sinceIso.replace(/[:.]/g, "-");
  const untilKey = untilIso.replace(/[:.]/g, "-");
  const matched = keys.filter((k) => {
    const ts = k.split("/")[1] || "";
    return ts >= sinceKey && ts < untilKey;
  });
  const entries = await Promise.all(
    matched.map(async (k) => {
      try {
        return await store.get(k, { type: "json" });
      } catch {
        return null;
      }
    })
  );
  const perJob = {};
  let totalRows = 0;
  const rawRuns = [];
  for (const entry of entries) {
    if (!entry) continue;
    const jobName = entry.jobName || "unknown";
    if (!perJob[jobName]) perJob[jobName] = { runs: 0, rows: 0 };
    perJob[jobName].runs += 1;
    rawRuns.push({
      jobName,
      date: entry.date,
      writes: entry.writes.map((w) => ({ kind: w.kind, table: w.table, rowCount: w.rowCount, time: w.time })),
    });
    for (const w of entry.writes) {
      perJob[jobName].rows += w.rowCount;
      totalRows += w.rowCount;
    }
  }
  return { window: { since: sinceIso, until: untilIso }, matchedKeys: matched.length, totalRowsWritten: totalRows, perJob, rawRuns };
}

export default async (request) => {
  const url = new URL(request.url);
  if (url.searchParams.get("token") !== TOKEN) {
    return json(401, { error: "Unauthorized" });
  }

  const result = { generatedAt: new Date().toISOString() };

  if (pool) {
    const client = await pool.connect();
    try {
      const { rows } = await client.query(
        `SELECT relname AS table, n_tup_ins AS ins, n_tup_upd AS upd, n_tup_del AS del, n_tup_hot_upd AS hot_upd
           FROM pg_stat_user_tables
          ORDER BY n_tup_upd DESC`
      );
      result.pgStatUserTables = rows;
    } finally {
      client.release();
    }
  }

  const store = getStore(STORE_NAME);
  const keys = [];
  let cursor;
  do {
    const page = await store.list({ cursor });
    for (const { key } of page.blobs) keys.push(key);
    cursor = page.cursor;
  } while (cursor);
  result.totalBlobKeys = keys.length;

  // local-as-shown reading: "Aug 4, 7:32:23pm" taken literally as UTC-ish,
  // widened generously; and the CEST (UTC+2) reading of that same wall clock.
  result.windowA_asShownWide = await windowTotals(store, keys, "2026-08-04T18:30:00.000Z", "2026-08-04T20:00:00.000Z");
  result.windowB_cestReading = await windowTotals(store, keys, "2026-08-04T17:00:00.000Z", "2026-08-04T18:30:00.000Z");
  result.fullDay = await windowTotals(store, keys, "2026-08-04T00:00:00.000Z", "2026-08-05T00:00:00.000Z");

  return json(200, result);
};
