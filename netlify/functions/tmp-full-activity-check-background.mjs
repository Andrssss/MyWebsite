// DISPOSABLE — 2026-09-22. Full read-only activity-label audit for the
// AI-scraped + ats-crawl sources: collects every row whose `active` flag
// looks wrong, using the EXACT production dead/alive rules
// (isDeadResult/isAliveResult/sweepProbeFor from _active_core.mjs, the same
// ones sweepActive404/reviveSweepDead use) — no UPDATE anywhere, collection
// only per user request. What to do with the findings is a separate
// follow-up. Delete after use.
//
// Three passes:
//   1. ACTIVE rows -> confirmed-dead candidates (mirrors sweepActive404's own
//      double-check, minus the write).
//   2. INACTIVE rows -> confirmed-alive candidates, using the EXACT same
//      candidate-selection query reviveSweepDead runs (sweep_dead=true rows,
//      plus ALL of ats-crawl since it's in SWEEP_SOLE_DEACTIVATOR_SOURCES,
//      plus AI-scraped rows first_seen within REVIVE_MAX_AGE_DAYS).
//   3. Among ACTIVE rows NOT covered by any wired per-platform rule (no
//      SWEEP_PROBE_OVERRIDES hit, no dedicated body rule), a title-word-hit
//      heuristic flags possible coverage gaps for manual triage (same method
//      as the 2026-09-15 review pass documented in _ai_liveness.mjs).
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

const TOKEN = "d43771cdebbfe2b14af4af055c4c497bad4b5564f69a8898";
const SOURCES = ["AI-scraped", "ats-crawl"];
const CONCURRENCY = 15;

// Hosts with a dedicated BODY-based dead rule in _ai_liveness.mjs that is NOT
// reached via a SWEEP_PROBE_OVERRIDES redirect (Ashby/Workable/cigpannonia/
// trskarrier all read the row's OWN page body) — excluded from the "uncovered
// fallback" bucket, same list the 2026-09-15 review pass used.
const BODY_COVERED_HOSTS = new Set([
  "jobs.ashbyhq.com",
  "apply.workable.com",
  "cigpannonia.hu",
  "trskarrier.hu",
]);

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return null; }
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

const _runJob = withTimeout("tmp-full-activity-check-background", async () => {
  const store = getStore("tmp-full-activity-check-result");
  const pool = new Pool({ connectionString: process.env.NETLIFY_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();
  const out = { startedAt: new Date().toISOString() };

  try {
    // ---------- Pass 1: ACTIVE rows -> dead candidates ----------
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

    // ---------- Pass 3 prep: fallback/uncovered heuristic on the NOT-dead bucket ----------
    const fallbackReviewCandidates = [];
    for (const r of firstPass) {
      if (r.dead) continue; // already caught by the wired rule
      const host = hostOf(r.row.url);
      const covered = r.probe.overridden || (host && BODY_COVERED_HOSTS.has(host));
      if (covered) continue;
      if (!(r.res.status >= 200 && r.res.status < 300)) continue; // non-2xx handled separately if needed
      const frac = titleHitFraction(r.row.title, r.res.body);
      if (frac !== null && frac < 0.4) {
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

    // ---------- Pass 2: INACTIVE rows -> alive candidates (reviveSweepDead's own query, scoped) ----------
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
