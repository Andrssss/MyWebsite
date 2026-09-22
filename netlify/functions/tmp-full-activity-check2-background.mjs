// DISPOSABLE — 2026-09-22. Re-run of the full read-only activity-label audit
// for AI-scraped + ats-crawl, AFTER deploying the 3 liveness-rule fixes found
// by the first pass (widened Workable host check, morganstanley.eightfold.ai,
// hrfelho.hu DEAD_PHRASES entry). User wants confirmation that nothing else
// needs deactivating before any real write happens. Still read-only — no
// UPDATE anywhere. Delete after use.
//
// Same three passes as the first run:
//   1. ACTIVE rows -> confirmed-dead candidates (mirrors sweepActive404's own
//      double-check, minus the write).
//   2. INACTIVE rows -> confirmed-alive candidates, using the EXACT same
//      candidate-selection query reviveSweepDead runs.
//   3. Among ACTIVE rows NOT covered by any wired per-platform rule, a
//      title-word-hit heuristic flags possible coverage gaps for manual
//      triage — threshold widened to 0.5 (was 0.4) this pass, to catch any
//      borderline case the first pass's tighter cutoff might have missed.
import { Pool } from "pg";
import { getStore } from "@netlify/blobs";
import { withTimeout } from "./_error-logger.mjs";
import {
  isDeadResult,
  isAliveResult,
  sweepProbeFor,
  SWEEP_EXCLUDED_SOURCES,
  SWEEP_SOLE_DEACTIVATOR_SOURCES,
  REVIVE_MAX_AGE_DAYS,
} from "./_active_core.mjs";
import { fetchFinal } from "./cron_404sweep-background.mjs";

const TOKEN = "a3d8c74f2e769fcc759ef583e0069d4c0554b96cc5f56b4a";
const SOURCES = ["AI-scraped", "ats-crawl"];
const CONCURRENCY = 15;

const BODY_COVERED_HOSTS = new Set([
  "jobs.ashbyhq.com",
  "apply.workable.com",
  "cigpannonia.hu",
  "trskarrier.hu",
]);

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return null; }
}
function isWorkable(host) {
  return !!host && /(^|\.)workable\.com$/.test(host);
}

async function probeRow(row) {
  const p = sweepProbeFor(row);
  const res = await fetchFinal(p.url, { wantBody: true, headers: p.headers });
  return { probe: p, res };
}

async function mapConcurrent(items, worker, limit) {
  const results = new Array(items.length);
  let i = 0;
  async function next() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await worker(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, next));
  return results;
}

function titleHitFraction(title, body) {
  if (!title || typeof body !== "string" || !body) return null;
  const clean = body.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").toLowerCase();
  const words = [...new Set((title.toLowerCase().match(/[a-záéíóöőúüű]{4,}/gi) || []))];
  if (words.length === 0) return null;
  const hits = words.filter((w) => clean.includes(w)).length;
  return hits / words.length;
}

const _runJob = withTimeout("tmp-full-activity-check2-background", async () => {
  const store = getStore("tmp-full-activity-check2-result");
  const pool = new Pool({ connectionString: process.env.NETLIFY_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();
  const out = { startedAt: new Date().toISOString() };

  try {
    const { rows: activeRows } = await client.query(
      `SELECT url, source, title, company, first_seen FROM job_posts
        WHERE active = true AND source = ANY($1::text[])
        ORDER BY source, company`,
      [SOURCES]
    );

    const firstPass = await mapConcurrent(activeRows, async (row) => {
      const { probe, res } = await probeRow(row);
      return { row, probe, res, dead: isDeadResult(row, res) };
    }, CONCURRENCY);

    const suspects = firstPass.filter((r) => r.dead);
    const deadConfirmed = [];
    for (const s of suspects) {
      const { res: res2 } = await probeRow(s.row);
      if (isDeadResult(s.row, res2)) {
        deadConfirmed.push({
          source: s.row.source, title: s.row.title, company: s.row.company,
          url: s.row.url, first_seen: s.row.first_seen, status: res2.status, finalUrl: res2.finalUrl,
        });
      }
    }

    const fallbackReviewCandidates = [];
    for (const r of firstPass) {
      if (r.dead) continue;
      const host = hostOf(r.row.url);
      const covered = r.probe.overridden || (host && BODY_COVERED_HOSTS.has(host)) || isWorkable(host);
      if (covered) continue;
      if (!(r.res.status >= 200 && r.res.status < 300)) continue;
      const frac = titleHitFraction(r.row.title, r.res.body);
      if (frac !== null && frac < 0.5) {
        fallbackReviewCandidates.push({
          source: r.row.source, title: r.row.title, company: r.row.company,
          url: r.row.url, status: r.res.status, finalUrl: r.res.finalUrl, hitFraction: frac,
          snippet: typeof r.res.body === "string" ? r.res.body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300) : null,
        });
      }
    }

    out.active = {
      checked: activeRows.length,
      suspects: suspects.length,
      deadConfirmed,
      fallbackReviewCandidates,
    };
    await store.setJSON("latest.json", { ...out, inProgress: "inactive-pass" });

    const soleSources = [...SWEEP_SOLE_DEACTIVATOR_SOURCES];
    const { rows: inactiveRows } = await client.query(
      `SELECT url, source, title, company, first_seen, sweep_dead FROM job_posts
        WHERE active = false
          AND (sweep_dead = true OR source = ANY($3::text[]))
          AND NOT (source = ANY($1::text[]))
          AND (source = ANY($3::text[]) OR first_seen >= NOW() - make_interval(days => $2::int))
          AND source = ANY($4::text[])
        ORDER BY source, company`,
      [[...SWEEP_EXCLUDED_SOURCES], REVIVE_MAX_AGE_DAYS, soleSources, SOURCES]
    );

    const revivePass = await mapConcurrent(inactiveRows, async (row) => {
      const { res } = await probeRow(row);
      return { row, alive: isAliveResult(row, res) };
    }, CONCURRENCY);

    const aliveCandidates = revivePass.filter((r) => r.alive);
    const aliveConfirmed = [];
    for (const c of aliveCandidates) {
      const { res: res2 } = await probeRow(c.row);
      if (isAliveResult(c.row, res2)) {
        aliveConfirmed.push({
          source: c.row.source, title: c.row.title, company: c.row.company,
          url: c.row.url, first_seen: c.row.first_seen, sweep_dead: c.row.sweep_dead,
          status: res2.status, finalUrl: res2.finalUrl,
        });
      }
    }

    out.inactive = {
      eligibleChecked: inactiveRows.length,
      aliveConfirmed,
    };

    out.finishedAt = new Date().toISOString();
    await store.setJSON("latest.json", out);
  } catch (err) {
    await store.setJSON("latest.json", { ...out, finishedAt: new Date().toISOString(), error: err.message, stack: err.stack });
  } finally {
    client.release();
    await pool.end();
  }
  return new Response("OK");
});

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });
  return _runJob(request);
};
