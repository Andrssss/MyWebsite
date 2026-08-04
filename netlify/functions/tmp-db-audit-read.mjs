/**
 * TEMP diagnostic endpoint — reads the "db-write-audit" blob store
 * (netlify/functions/_db_audit.js) to attribute job_posts INSERT/UPDATE/DELETE
 * volume to specific cron jobs. Disposable — delete after use.
 *
 * GET modes:
 *   ?mode=totals&date=2026-08-03                → per-jobName run count + write count (cheap, key-only)
 *   ?mode=window&since=ISO&until=ISO             → full breakdown for a narrow window (fetches blob content)
 */
import { getStore } from "@netlify/blobs";

const TOKEN = "c594f38948da3233b513c0f534aa0f6a916365c26cf4fe2f";
const STORE_NAME = "db-write-audit";

export default async (request) => {
  const url = new URL(request.url);
  if (url.searchParams.get("token") !== TOKEN) {
    return new Response("Unauthorized", { status: 401 });
  }

  const store = getStore(STORE_NAME);
  const mode = url.searchParams.get("mode") || "totals";

  // Collect all keys first (cheap: list() doesn't fetch blob bodies).
  const keys = [];
  let cursor;
  do {
    const page = await store.list({ cursor });
    for (const { key } of page.blobs) keys.push(key);
    cursor = page.cursor;
  } while (cursor);

  if (mode === "totals") {
    const date = url.searchParams.get("date") || new Date().toISOString().slice(0, 10);
    const matched = keys.filter((k) => k.includes(date));
    const byJob = {};
    for (const k of matched) {
      const jobName = k.split("/")[0];
      byJob[jobName] = (byJob[jobName] || 0) + 1;
    }
    return Response.json({
      totalBlobKeys: keys.length,
      dateFilter: date,
      matchedRuns: matched.length,
      runsPerJob: Object.fromEntries(
        Object.entries(byJob).sort((a, b) => b[1] - a[1])
      ),
    });
  }

  if (mode === "window") {
    const since = url.searchParams.get("since");
    const until = url.searchParams.get("until");
    if (!since || !until) {
      return Response.json({ error: "since and until (ISO) required for mode=window" }, { status: 400 });
    }
    const sinceKey = since.replace(/[:.]/g, "-");
    const untilKey = until.replace(/[:.]/g, "-");

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
    const perTableKind = {};
    let totalRows = 0;
    const rawRuns = [];

    for (const entry of entries) {
      if (!entry) continue;
      const jobName = entry.jobName || "unknown";
      if (!perJob[jobName]) perJob[jobName] = { runs: 0, writeEvents: 0, rows: 0 };
      perJob[jobName].runs += 1;
      perJob[jobName].writeEvents += entry.writes.length;

      rawRuns.push({
        jobName,
        date: entry.date,
        writeCount: entry.writeCount,
        writes: entry.writes.map((w) => ({ kind: w.kind, table: w.table, rowCount: w.rowCount, time: w.time })),
      });

      for (const w of entry.writes) {
        perJob[jobName].rows += w.rowCount;
        totalRows += w.rowCount;
        const tk = `${w.table}:${w.kind}`;
        perTableKind[tk] = (perTableKind[tk] || 0) + w.rowCount;
      }
    }

    return Response.json({
      window: { since, until },
      matchedKeys: matched.length,
      totalRowsWritten: totalRows,
      perJob,
      perTableKind,
      rawRuns,
    });
  }

  return Response.json({ error: "unknown mode" }, { status: 400 });
};
