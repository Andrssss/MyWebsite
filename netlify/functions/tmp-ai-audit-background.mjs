// DISPOSABLE audit endpoint — 2026-09-09. Full read-only sweep of the
// AI-scraped bucket (source='AI-scraped', plus any lingering legacy
// "AI - <site>" rows): cross-source dupe candidates (full-table, any-pair,
// dupeKey only) + a fresh liveness check on every remaining row in both
// directions (active-but-dead AND inactive-but-alive), reusing the exact
// sweepProbeFor/isDeadResult/isAliveResult rules prod's own 404 sweep uses.
// Writes a JSON report to the "tmp-ai-audit" blob store. No DB writes here.
// Delete after use.

import { Pool } from "pg";
import http from "http";
import https from "https";
import { getStore } from "@netlify/blobs";
import { sweepProbeFor, isDeadResult, isAliveResult } from "./_active_core.mjs";
import { dupeKey } from "../../src/lib/crossSourceDupe.mjs";

const TOKEN = "763f13e6df929c214d0fdd59a54d83098c16151213335d01";

const connectionString = process.env.NETLIFY_DATABASE_URL;
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

const REQUEST_TIMEOUT_MS = 15000;
const BODY_CAP_BYTES = 1_500_000;

function fixLocationEncoding(loc) {
  const decoded = Buffer.from(loc, "latin1").toString("utf8");
  return decoded.includes("�") ? loc : decoded;
}

function fetchFinal(url, opts = {}, redirectLeft = 5) {
  const wantBody = opts.wantBody === true;
  return new Promise((resolve) => {
    let parsed;
    try { parsed = new URL(url); } catch { return resolve({ status: -1, finalUrl: null }); }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return resolve({ status: -1, finalUrl: null });
    }
    const lib = parsed.protocol === "https:" ? https : http;
    const req = lib.request(parsed, {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/json,*/*;q=0.8",
        "Accept-Language": "hu-HU,hu;q=0.9,en;q=0.8",
        "Accept-Encoding": wantBody ? "identity" : "gzip,deflate,br",
        ...(opts.headers || {}),
      },
      timeout: REQUEST_TIMEOUT_MS,
    }, (res) => {
      const code = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(code)) {
        res.resume();
        const loc = res.headers.location;
        if (!loc || redirectLeft <= 0) return resolve({ status: code, finalUrl: url });
        try { return resolve(fetchFinal(new URL(fixLocationEncoding(loc), url).toString(), opts, redirectLeft - 1)); }
        catch { return resolve({ status: code, finalUrl: url }); }
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        if (body.length < BODY_CAP_BYTES) body += chunk;
        else res.destroy();
      });
      res.on("end", () => resolve({ status: code, finalUrl: url, body }));
      res.on("close", () => resolve({ status: code, finalUrl: url, body }));
      res.on("error", () => resolve({ status: code, finalUrl: url, body }));
    });
    req.on("timeout", () => { req.destroy(); resolve({ status: -2, finalUrl: null }); });
    req.on("error", () => resolve({ status: -3, finalUrl: null }));
    req.end();
  });
}

// Legacy "AI - <site>" rows get treated as the "AI-scraped" source for the
// purpose of asking sweepProbeFor/isDeadResult/isAliveResult the platform-
// specific question (same content, old naming) — those rule tables are keyed
// on the exact string "AI-scraped".
function asAiRow(row) {
  return { url: row.url, source: "AI-scraped" };
}

async function probeAndCheckOnce(row) {
  const p = sweepProbeFor(asAiRow(row));
  return fetchFinal(p.url, { wantBody: true, headers: p.headers });
}

async function runPool(items, worker, concurrency) {
  const results = new Array(items.length);
  let next = 0;
  async function lane() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, lane));
  return results;
}

async function run() {
  const client = await pool.connect();
  let aiRows, otherRows;
  try {
    const r1 = await client.query(
      `SELECT id, url, source, title, company, technologies, active, first_seen
         FROM job_posts
        WHERE source = 'AI-scraped' OR source LIKE 'AI - %'
        ORDER BY id`
    );
    aiRows = r1.rows;

    const r2 = await client.query(
      `SELECT company, title, source, url, active
         FROM job_posts
        WHERE NOT (source = 'AI-scraped' OR source LIKE 'AI - %')
          AND company IS NOT NULL AND company <> ''
          AND title IS NOT NULL AND title <> ''`
    );
    otherRows = r2.rows;
  } finally {
    client.release();
  }

  const legacyCount = aiRows.filter((r) => r.source !== "AI-scraped").length;
  const activeCount = aiRows.filter((r) => r.active).length;
  const inactiveCount = aiRows.length - activeCount;

  // Build dupeKey -> [{source,url,active}] index over EVERY other source
  // (full-table, any-pair — not just CROSS_SOURCE_DUPE_SOURCES) so nothing
  // is silently missed the way a hardcoded whitelist would.
  const otherIndex = new Map();
  for (const r of otherRows) {
    const key = dupeKey(r.company, r.title);
    if (!key) continue;
    if (!otherIndex.has(key)) otherIndex.set(key, []);
    otherIndex.get(key).push({ source: r.source, url: r.url, active: r.active });
  }

  const dupeCandidates = [];
  const nonDupeRows = [];
  for (const row of aiRows) {
    const key = dupeKey(row.company, row.title);
    const matches = key ? otherIndex.get(key) : null;
    if (matches && matches.length) {
      dupeCandidates.push({
        id: row.id, url: row.url, source: row.source, title: row.title,
        company: row.company, active: row.active, key, matches,
      });
    } else {
      nonDupeRows.push(row);
    }
  }

  // Liveness pass on every non-dupe row, both directions, double-checked
  // like the real sweep (sweepActive404 / reviveSweepDead) before confirming.
  const deactivateCandidates = [];
  const reactivateCandidates = [];
  const inconclusive = [];

  await runPool(nonDupeRows, async (row) => {
    const first = await probeAndCheckOnce(row);
    if (row.active) {
      if (isDeadResult(asAiRow(row), first)) {
        const second = await probeAndCheckOnce(row);
        if (isDeadResult(asAiRow(row), second)) {
          deactivateCandidates.push({
            id: row.id, url: row.url, source: row.source, title: row.title,
            company: row.company, first_seen: row.first_seen,
            status: second.status, finalUrl: second.finalUrl,
          });
        }
      }
    } else {
      if (isAliveResult(asAiRow(row), first)) {
        const second = await probeAndCheckOnce(row);
        if (isAliveResult(asAiRow(row), second)) {
          reactivateCandidates.push({
            id: row.id, url: row.url, source: row.source, title: row.title,
            company: row.company, first_seen: row.first_seen,
            status: second.status, finalUrl: second.finalUrl,
          });
        }
      }
    }
    return null;
  }, 15);

  const report = {
    generatedAt: new Date().toISOString(),
    totals: {
      aiRows: aiRows.length,
      legacyAiDashRows: legacyCount,
      active: activeCount,
      inactive: inactiveCount,
      otherSourceRowsIndexed: otherRows.length,
    },
    dupeCandidates,
    deactivateCandidates,
    reactivateCandidates,
    counts: {
      dupeCandidates: dupeCandidates.length,
      deactivateCandidates: deactivateCandidates.length,
      reactivateCandidates: reactivateCandidates.length,
      checkedNonDupe: nonDupeRows.length,
    },
  };

  await getStore({ name: "tmp-ai-audit", consistency: "strong" }).setJSON("report.json", report);
  console.log(`[tmp-ai-audit] done: ${JSON.stringify(report.counts)} totals=${JSON.stringify(report.totals)}`);
}

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });
  await run();
  return new Response("OK");
};
