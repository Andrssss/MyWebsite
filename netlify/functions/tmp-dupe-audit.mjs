// DISPOSABLE cleanup endpoint — 2026-09-03, revised design per user direction:
//
//   - SAME-SOURCE duplicates (same dupeKey, same source, different url): the
//     source's own extraction is internally consistent, so technology IS a
//     trustworthy signal here. If tech clearly differs (isLikelySamePosting
//     false), keep both -- they're genuinely different postings that happen
//     to share a title+company (the Deutsche Telekom pattern, which in the
//     original find WAS same-source, all 4 rows on nofluffjobs itself). If
//     tech matches or can't be compared, they're the same posting re-listed
//     -- deactivate all but the earliest-first_seen row.
//
//   - CROSS-SOURCE duplicates (same dupeKey, different sources): technology
//     extraction quality varies too much between site templates to trust as
//     a signal (proven today on live data multiple times). So for these we
//     do NOT use tech, and we do NOT auto-act (no deactivation) -- we only
//     RECORD the candidate cluster to a Netlify Blob store for later human
//     analysis, exactly as instructed.
//
// Default is a DRY RUN (no writes at all, DB or blob) -- pass ?commit=1 to
// actually deactivate same-source dupes AND write the cross-source report
// blob. Delete this file after use.

import { Pool } from "pg";
import { getStore } from "@netlify/blobs";
import { dupeKey, isLikelySamePosting, CROSS_SOURCE_DUPE_SOURCES } from "../../src/lib/crossSourceDupe.mjs";

const TOKEN = "d11950281aa2e71303553b45821c4ffe7685e80a";
const pool = new Pool({ connectionString: process.env.NETLIFY_DATABASE_URL, ssl: { rejectUnauthorized: false } });
const REPORT_STORE = "cross-source-dupe-candidates";

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

    const toDeactivate = [];
    const sameSourceReport = [];
    const crossSourceCandidates = [];

    for (const [key, groupRows] of keyGroups) {
      // 1) same-source sub-clustering, tech-aware
      const bySource = new Map();
      for (const r of groupRows) {
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
          for (const d of drop) toDeactivate.push(d.id);
          sameSourceReport.push({
            key,
            title: keep.title,
            company: keep.company,
            source: keep.source,
            keep: `${keep.first_seen}: ${keep.url}`,
            deactivate: drop.map((d) => `${d.first_seen}: ${d.url}`),
          });
        }
      }

      // 2) cross-source candidates -- key match alone, no tech filtering,
      // never deactivated, only reported.
      const distinctSources = new Set(groupRows.map((r) => r.source));
      if (distinctSources.size >= 2) {
        crossSourceCandidates.push({
          key,
          title: groupRows[0].title,
          company: groupRows[0].company,
          rows: groupRows.map((r) => ({
            source: r.source,
            url: r.url,
            first_seen: r.first_seen,
            technologyCount: (r.technologies || "").split(",").filter((t) => t.trim()).length,
          })),
        });
      }
    }

    let committed = false;
    let blobKey = null;
    if (commit) {
      if (toDeactivate.length > 0) {
        await client.query(`UPDATE job_posts SET active = false WHERE id = ANY($1::int[])`, [toDeactivate]);
      }
      const store = getStore(REPORT_STORE);
      blobKey = `report-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
      await store.setJSON(blobKey, {
        generatedAt: new Date().toISOString(),
        totalActiveRowsScanned: rows.length,
        crossSourceCandidateClusters: crossSourceCandidates.length,
        candidates: crossSourceCandidates,
      });
      committed = true;
    }

    return new Response(
      JSON.stringify(
        {
          mode: commit ? "COMMIT" : "DRY_RUN",
          committed,
          blobKey,
          totalActiveRowsScanned: rows.length,
          sameSourceDupeClusters: sameSourceReport.length,
          sameSourceRowsToDeactivate: toDeactivate.length,
          sameSourceReport,
          crossSourceCandidateClusters: crossSourceCandidates.length,
          crossSourceCandidates,
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
