// Disposable, read-only investigation (2026-09-02): what caused the Neon
// "Rows" chart spike (~185 inserted / 36 updated / 127 deleted) around
// 2026-09-02 20:10 (chart tooltip time, tz unconfirmed). Lists db-write-audit
// blobs for the day and aggregates writeCount by jobName/kind/table, plus a
// full dump of entries whose blob timestamp falls in the requested window.
// No DB writes. Delete after use.

import { getStore } from "@netlify/blobs";

const TOKEN = "7c9f1e4a2b6d8035c1e7a9f4b62d0e58a3c7f19b";
const STORE_NAME = "db-write-audit";

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (token !== TOKEN) return new Response("Unauthorized", { status: 401 });

  const url = new URL(request.url);
  const datePrefix = url.searchParams.get("date") || "2026-09-02";
  const fromHour = Number(url.searchParams.get("fromHour") ?? 17);
  const toHour = Number(url.searchParams.get("toHour") ?? 22);

  try {
    const store = getStore(STORE_NAME);
    const out = [];
    let cursor;
    for (;;) {
      const res = await store.list({ cursor });
      const blobs = res?.blobs || [];
      out.push(...blobs);
      cursor = res?.cursor;
      if (!cursor) break;
    }

    const dayBlobs = out.filter((b) => b.key.includes(datePrefix));

    const byJob = {};
    const windowEntries = [];

    for (const b of dayBlobs) {
      const raw = await store.get(b.key, { type: "text" });
      if (!raw) continue;
      let entry;
      try {
        entry = JSON.parse(raw);
      } catch {
        continue;
      }
      const job = entry.jobName || "unknown";
      byJob[job] = byJob[job] || { writeCount: 0, byKindTable: {}, blobKeys: [] };
      byJob[job].writeCount += entry.writeCount || 0;
      byJob[job].blobKeys.push(b.key);

      // ts embedded in key as JOB/2026-09-02T20-10-07-123Z.json
      const m = b.key.match(/T(\d{2})-(\d{2})-(\d{2})/);
      const hour = m ? Number(m[1]) : null;

      for (const w of entry.writes || []) {
        const k = `${w.kind} ${w.table}`;
        byJob[job].byKindTable[k] = (byJob[job].byKindTable[k] || 0) + w.rowCount;
      }

      if (hour !== null && hour >= fromHour && hour <= toHour) {
        windowEntries.push({ key: b.key, jobName: job, date: entry.date, writeCount: entry.writeCount, writes: entry.writes });
      }
    }

    return new Response(
      JSON.stringify({ datePrefix, fromHour, toHour, totalBlobsThatDay: dayBlobs.length, byJob, windowEntries }, null, 2),
      { headers: { "content-type": "application/json" } }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message, stack: err.stack }, null, 2), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
};
