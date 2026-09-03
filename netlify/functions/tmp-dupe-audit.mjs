// DISPOSABLE cleanup endpoint — 2026-09-04. Finds same-source duplicate
// clusters (exact tech match, same as isLikelySamePosting) among currently
// ACTIVE rows in the tracked sources, and HARD DELETES every row in a
// cluster except the earliest-first_seen one. ats-crawl rows are excluded
// entirely (left alone -- likely genuine parallel Workday reqs, not dupes).
// Default is a DRY RUN (no writes) -- pass ?commit=1 to actually delete.
// Delete this file after use.

import { Pool } from "pg";
import { dupeKey, isLikelySamePosting, CROSS_SOURCE_DUPE_SOURCES } from "../../src/lib/crossSourceDupe.mjs";

const TOKEN = "2892bc66f219c5dc6313e22f74a080534ae6593a";
const pool = new Pool({ connectionString: process.env.NETLIFY_DATABASE_URL, ssl: { rejectUnauthorized: false } });
const EXCLUDED_SOURCES = new Set(["ats-crawl"]);

function clusterByPosting(rows) {
  const parent = rows.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (i, j) => {
    const a = find(i);
    const b = find(j);
    if (a !== b) parent[a] = b;
  };
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      if (isLikelySamePosting(rows[i], rows[j])) union(i, j);
    }
  }
  const clusters = new Map();
  rows.forEach((r, i) => {
    const root = find(i);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root).push(r);
  });
  return [...clusters.values()];
}

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) {
    return new Response("unauthorized", { status: 401 });
  }
  const url = new URL(request.url);
  const commit = url.searchParams.get("commit") === "1";

  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT id, source, company, title, url, technologies, first_seen
         FROM job_posts
        WHERE active = true
          AND source = ANY($1::text[])
          AND company IS NOT NULL AND company <> ''
          AND title IS NOT NULL AND title <> ''`,
      [CROSS_SOURCE_DUPE_SOURCES]
    );

    const keyGroups = new Map();
    for (const r of rows) {
      const key = dupeKey(r.company, r.title);
      if (!key) continue;
      if (!keyGroups.has(key)) keyGroups.set(key, []);
      keyGroups.get(key).push(r);
    }

    const toDelete = [];
    const report = [];
    for (const groupRows of keyGroups.values()) {
      const bySource = new Map();
      for (const r of groupRows) {
        if (EXCLUDED_SOURCES.has(r.source)) continue;
        if (!bySource.has(r.source)) bySource.set(r.source, []);
        bySource.get(r.source).push(r);
      }
      for (const sourceRows of bySource.values()) {
        if (sourceRows.length < 2) continue;
        for (const cluster of clusterByPosting(sourceRows)) {
          if (cluster.length < 2) continue;
          const sorted = [...cluster].sort((a, b) => new Date(a.first_seen) - new Date(b.first_seen));
          const keep = sorted[0];
          const drop = sorted.slice(1);
          for (const d of drop) toDelete.push(d.id);
          report.push({
            source: keep.source,
            title: keep.title,
            company: keep.company,
            keep: keep.url,
            deleted: drop.map((d) => d.url),
          });
        }
      }
    }

    let committed = false;
    if (commit && toDelete.length > 0) {
      await client.query(`DELETE FROM job_posts WHERE id = ANY($1::int[])`, [toDelete]);
      committed = true;
    }

    return new Response(
      JSON.stringify(
        {
          mode: commit ? "COMMIT" : "DRY_RUN",
          committed,
          totalActiveRowsScanned: rows.length,
          clustersFound: report.length,
          rowsDeleted: toDelete.length,
          report,
        },
        null,
        2
      ),
      { headers: { "content-type": "application/json" } }
    );
  } finally {
    client.release();
  }
};
