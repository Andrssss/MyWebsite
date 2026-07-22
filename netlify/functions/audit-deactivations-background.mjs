/*
  ONE-OFF temporary audit (delete after use — see MEMORY db-access-via-live-api
  recipe). Read-only: makes ZERO writes to job_posts. Scans inactive job_posts
  rows and, for each, re-checks the row's OWN url with the exact same
  death-rules production already trusts (_active_core.mjs REDIRECT_DEAD_SOURCES
  / BANNER_DEAD_SOURCES / plain-404), so this is the same independent channel
  cron_404sweep-background.mjs uses — not a re-run of any scraper's own
  extraction logic. Rows whose own url does NOT prove death are flagged as
  possibly wrongly deactivated. Results go to Blobs store "job-audit".
*/
import { Pool } from "pg";
import { getStore } from "@netlify/blobs";
import { withTimeout } from "./_error-logger.mjs";
import { fetchFinal } from "./cron_404sweep-background.mjs";
import {
  REDIRECT_DEAD_SOURCES,
  BANNER_DEAD_SOURCES,
  SWEEP_EXCLUDED_SOURCES,
} from "./_active_core.mjs";

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

const SCAN_WINDOW_DAYS = 75; // buffer over the "last 2 months" ask
const ROW_LIMIT = 8000;
const CONCURRENCY = 20;

function pathOf(u) {
  try {
    const p = new URL(u).pathname.replace(/\/+$/, "");
    return p || "/";
  } catch {
    return null;
  }
}

// Mirrors _active_core.mjs's private _isDeadResult — same rules, same sources.
function verdict(row, res) {
  if (!res || res.status < 0) return { dead: false, reason: `inconclusive:${res ? res.status : "no-response"}` };
  if (res.status === 404) return { dead: true, reason: "404" };

  if (REDIRECT_DEAD_SOURCES.has(row.source) && res.status >= 200 && res.status < 400 && res.finalUrl) {
    const a = pathOf(row.url);
    const b = pathOf(res.finalUrl);
    if (a !== null && b !== null && a !== b) return { dead: true, reason: "redirected-to-listing" };
  }

  const rule = BANNER_DEAD_SOURCES[row.source];
  if (rule && res.status === 200 && typeof res.body === "string") {
    const hit = typeof rule === "function" ? rule(row, res.body) : res.body.toLowerCase().includes(rule);
    if (hit) return { dead: true, reason: "banner-match" };
  }

  if (res.status >= 400 && res.status !== 404) return { dead: false, reason: `inconclusive:${res.status}` };
  return { dead: false, reason: res.status === 200 ? "200-alive" : `alive:${res.status}` };
}

const _runJob = withTimeout("audit-deactivations-background", async () => {
  const store = getStore("job-audit");
  await store.setJSON("latest", { status: "processing", startedAt: new Date().toISOString() });

  const client = await pool.connect();
  let rows;
  try {
    const totalInactive = await client.query(`SELECT COUNT(*)::int AS n FROM job_posts WHERE active = false`);
    const { rows: r } = await client.query(
      `SELECT id, source, url, title, company, first_seen
         FROM job_posts
        WHERE active = false
          AND first_seen >= NOW() - make_interval(days => $1::int)
        ORDER BY first_seen DESC
        LIMIT $2`,
      [SCAN_WINDOW_DAYS, ROW_LIMIT]
    );
    rows = r;
    console.log(`[audit] total inactive=${totalInactive.rows[0].n}, in-window=${rows.length}`);
  } finally {
    client.release();
  }

  const wantBody = (row) => ({ wantBody: BANNER_DEAD_SOURCES[row.source] !== undefined });
  const flagged = [];
  const perSource = new Map();
  const bump = (source, key) => {
    if (!perSource.has(source)) perSource.set(source, { total: 0, excluded: 0, deadConfirmed: 0, inconclusive: 0, flagged: 0 });
    perSource.get(source)[key]++;
  };

  const excluded = rows.filter((r) => SWEEP_EXCLUDED_SOURCES.has(r.source));
  const toCheck = rows.filter((r) => !SWEEP_EXCLUDED_SOURCES.has(r.source));
  for (const r of excluded) {
    bump(r.source, "total");
    bump(r.source, "excluded");
  }

  const lanes = Array.from({ length: CONCURRENCY }, (_, i) => toCheck.filter((_, idx) => idx % CONCURRENCY === i));
  await Promise.all(
    lanes.map(async (list) => {
      for (const row of list) {
        bump(row.source, "total");
        let res;
        try {
          res = await fetchFinal(row.url, wantBody(row));
        } catch {
          res = { status: -3, finalUrl: null };
        }
        const v = verdict(row, res);
        if (v.dead) {
          bump(row.source, "deadConfirmed");
        } else if (v.reason.startsWith("inconclusive")) {
          bump(row.source, "inconclusive");
        } else {
          bump(row.source, "flagged");
          flagged.push({
            id: row.id,
            source: row.source,
            url: row.url,
            title: row.title,
            company: row.company,
            firstSeen: row.first_seen,
            status: res.status,
            finalUrl: res.finalUrl && res.finalUrl !== row.url ? res.finalUrl : null,
            reason: v.reason,
          });
        }
      }
    })
  );

  for (const r of excluded) {
    flagged.push({
      id: r.id,
      source: r.source,
      url: r.url,
      title: r.title,
      company: r.company,
      firstSeen: r.first_seen,
      status: null,
      finalUrl: null,
      reason: "excluded-source-needs-manual-check",
    });
  }

  const result = {
    status: "done",
    finishedAt: new Date().toISOString(),
    scanWindowDays: SCAN_WINDOW_DAYS,
    rowLimit: ROW_LIMIT,
    totalScanned: rows.length,
    perSource: Object.fromEntries(perSource),
    flagged,
  };
  await store.setJSON("latest", result);
  console.log(`[audit] done. scanned=${rows.length} flagged=${flagged.length}`);
  return new Response("OK");
});

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  const expected = process.env.CRON_SECRET;
  if (!expected || token !== expected) {
    return new Response("Unauthorized", { status: 401 });
  }
  return _runJob(request);
};
