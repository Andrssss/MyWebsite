// TEMP diagnostic — round 2: did marketing_job_posts grow since the last
// baseline (11046 ins / 11610 upd / 11046 del, captured 2026-08-04 ~19:48 UTC)?
// Disposable — delete after use.
import pkg from "pg";
const { Pool } = pkg;
import { getStore } from "@netlify/blobs";

const connectionString = process.env.NETLIFY_DATABASE_URL;
const pool = connectionString ? new Pool({ connectionString, ssl: { rejectUnauthorized: false } }) : null;
const TOKEN = "a19f4d7c62b8e0913fd6a52c8b7e10493dfa62c1b8e5";

async function windowTotals(sinceIso, untilIso) {
  const store = getStore("db-write-audit");
  const keys = [];
  let cursor;
  do {
    const page = await store.list({ cursor });
    for (const { key } of page.blobs) keys.push(key);
    cursor = page.cursor;
  } while (cursor);
  const sinceKey = sinceIso.replace(/[:.]/g, "-");
  const untilKey = untilIso.replace(/[:.]/g, "-");
  const matched = keys.filter((k) => {
    const ts = k.split("/")[1] || "";
    return ts >= sinceKey && ts < untilKey;
  });
  const entries = await Promise.all(matched.map((k) => store.get(k, { type: "json" }).catch(() => null)));
  const rawRuns = [];
  let totalRows = 0;
  for (const entry of entries) {
    if (!entry) continue;
    rawRuns.push({ jobName: entry.jobName, date: entry.date, writes: entry.writes });
    for (const w of entry.writes) totalRows += w.rowCount;
  }
  return { window: { since: sinceIso, until: untilIso }, matchedKeys: matched.length, totalRowsWritten: totalRows, rawRuns };
}

function json(status, body) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

// full-table baseline captured 2026-08-04T19:41:28Z (before the 11:37:39pm-local spike)
const FULL_BASELINE = {
  job_posts: { ins: 17658, upd: 206502, del: 9009 },
  admin_applied_jobs: { ins: 203, upd: 20769, del: 90 },
  marketing_job_posts: { ins: 11046, upd: 11610, del: 11046 },
  job_categories: { ins: 19, upd: 484, del: 6 },
  subject_reviews: { ins: 409, upd: 302, del: 176 },
  job_daily_stats: { ins: 1081, upd: 49, del: 925 },
  job_daily_categories: { ins: 10448, upd: 11, del: 8154 },
  daily_visitors: { ins: 676, upd: 6, del: 21 },
  ingatlan_listings: { ins: 84, upd: 5, del: 35 },
  bug_reports: { ins: 14, upd: 0, del: 14 },
  job_filters: { ins: 1678, upd: 0, del: 260 },
  visitor_click_dates: { ins: 1885, upd: 0, del: 0 },
  marketing_filters: { ins: 314, upd: 0, del: 48 },
  subject_requests: { ins: 0, upd: 0, del: 0 },
  targy_kerelem: { ins: 3, upd: 0, del: 3 },
  property_listings: { ins: 0, upd: 0, del: 0 },
};

export default async (request) => {
  const url = new URL(request.url);
  if (url.searchParams.get("token") !== TOKEN) return json(401, { error: "Unauthorized" });

  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT relname AS table, n_tup_ins AS ins, n_tup_upd AS upd, n_tup_del AS del
         FROM pg_stat_user_tables
        ORDER BY relname`
    );
    const deltas = rows.map((r) => {
      const base = FULL_BASELINE[r.table];
      if (!base) return { table: r.table, note: "no baseline (new table?)", current: r };
      return {
        table: r.table,
        deltaIns: Number(r.ins) - base.ins,
        deltaUpd: Number(r.upd) - base.upd,
        deltaDel: Number(r.del) - base.del,
      };
    });
    const url2 = new URL(request.url);
    const sinceParam = url2.searchParams.get("since");
    const untilParam = url2.searchParams.get("until");
    const liveWindow = sinceParam && untilParam ? await windowTotals(sinceParam, untilParam) : null;

    return json(200, {
      now: new Date().toISOString(),
      baselineFrom: "2026-08-04T19:41:28Z",
      deltas,
      liveWindow,
    });
  } finally {
    client.release();
  }
};
