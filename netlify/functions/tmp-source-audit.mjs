// DISPOSABLE diagnostic — 2026-09-10, investigating issue #13's "unverifiable"
// sources (nofluffjobs, startupjobs, alllocaljobs, tudasdiak, prodiak, zyntern).
// Read-only except for the optional ?revive= action, which reuses the same
// evidence-based row-flip as the (deleted) tmp-revive-issue13.mjs. Delete after use.
import { Pool } from "pg";
import { getStore } from "@netlify/blobs";
import { loadFilters } from "./load_filters.mjs";
import { shouldSkipTitleFilter } from "./_seniority_policy.mjs";

const TOKEN = "f3c9a812e6d045b7180ce2f976a8d5b1e04c73a92f6081d3";
const connectionString = process.env.NETLIFY_DATABASE_URL;
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

async function sourceStats(client, source) {
  const { rows: counts } = await client.query(
    `SELECT active, count(*)::int AS n FROM job_posts WHERE source = $1 GROUP BY active`,
    [source]
  );
  const { rows: oldestActive } = await client.query(
    `SELECT url, first_seen FROM job_posts WHERE source = $1 AND active = true
      ORDER BY first_seen ASC LIMIT 5`,
    [source]
  );
  const { rows: newestInactive } = await client.query(
    `SELECT url, first_seen FROM job_posts WHERE source = $1 AND active = false
      ORDER BY first_seen DESC LIMIT 5`,
    [source]
  );
  const { rows: sampleActive } = await client.query(
    `SELECT url, first_seen FROM job_posts WHERE source = $1 AND active = true
      ORDER BY random() LIMIT 5`,
    [source]
  );
  return { counts, oldestActive, newestInactive, sampleActive };
}

async function recentRecovery(source, limit = 30) {
  const store = getStore("recovery-logs");
  const { blobs } = await store.list({ prefix: "cron_404sweep-background/" });
  const sorted = blobs.sort((a, b) => (a.key < b.key ? 1 : -1)).slice(0, limit);
  const matches = [];
  for (const b of sorted) {
    const text = await store.get(b.key, { type: "text" });
    if (!text) continue;
    let entry;
    try { entry = JSON.parse(text); } catch { continue; }
    for (const ev of entry.events || []) {
      if (ev.source === source) matches.push({ file: b.key, ...ev });
    }
  }
  return { filesScanned: sorted.length, matches };
}

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });

  const params = new URL(request.url).searchParams;
  const source = params.get("source");
  const revive = params.get("revive"); // comma-separated urls
  const titleCheck = params.get("titlecheck"); // pipe-separated titles

  if (titleCheck) {
    const filters = await loadFilters();
    const titles = titleCheck.split("|").map((t) => t.trim()).filter(Boolean);
    const results = titles.map((t) => ({ title: t, skippedAsSenior: shouldSkipTitleFilter(t, filters) }));
    return new Response(JSON.stringify({ filterCount: filters.length, results }, null, 2), {
      headers: { "content-type": "application/json" },
    });
  }

  const client = await pool.connect();
  try {
    if (revive) {
      const urls = revive.split(",").map((u) => u.trim()).filter(Boolean);
      const { rows: before } = await client.query(
        `SELECT url, source, active, sweep_dead FROM job_posts WHERE url = ANY($1::text[])`,
        [urls]
      );
      const { rows: updated } = await client.query(
        `UPDATE job_posts SET active = true, sweep_dead = false
          WHERE url = ANY($1::text[]) RETURNING url, source, active, sweep_dead`,
        [urls]
      );
      return new Response(JSON.stringify({ before, updated }, null, 2), {
        headers: { "content-type": "application/json" },
      });
    }

    if (!source) return new Response("missing ?source= or ?revive=", { status: 400 });

    const [stats, recovery] = await Promise.all([
      sourceStats(client, source),
      recentRecovery(source),
    ]);
    return new Response(JSON.stringify({ source, stats, recovery }, null, 2), {
      headers: { "content-type": "application/json" },
    });
  } finally {
    client.release();
  }
};
