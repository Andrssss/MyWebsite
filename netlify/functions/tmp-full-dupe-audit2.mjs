// Disposable read-only audit, round 2: same as the 2026-09-05 full-table
// audit but with NO active/30-day filter — every row currently in job_posts
// (the table only ever holds <=60-day-inactive rows anyway, older ones are
// archived to the job-posts-archive Blob and deleted, so "all rows" here is
// bounded). Same methodology: cross-source = dupeKey collisions across
// sources (whitelist + any-pair); same-source = dupeKey collisions within
// one source, clustered by EXACT technologies match (union-find, transitive).
// Read-only. No writes.
import { Pool } from "pg";
import {
  dupeKey,
  CROSS_SOURCE_DUPE_SOURCES,
  technologiesExactMatch,
} from "../../src/lib/crossSourceDupe.mjs";

const TOKEN = "tmp-full-dupe-audit2-e47bd0";
const WHITELIST = new Set(CROSS_SOURCE_DUPE_SOURCES);

const pool = new Pool({
  connectionString: process.env.NETLIFY_DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

export default async (req) => {
  const auth = req.headers.get("authorization") || "";
  if (auth.replace(/^Bearer\s+/i, "").trim() !== TOKEN) {
    return new Response("unauthorized", { status: 401 });
  }

  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT id, source, title, company, url, technologies, first_seen, active
       FROM job_posts`
    );

    const bySource = {};
    for (const r of rows) bySource[r.source] = (bySource[r.source] || 0) + 1;

    // ---- cross-source ----
    const byKey = new Map();
    for (const r of rows) {
      const k = dupeKey(r.company, r.title);
      if (!k) continue;
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(r);
    }

    function crossSourceSummary(filterFn) {
      const groups = [];
      for (const [k, group] of byKey.entries()) {
        const filtered = group.filter((r) => filterFn(r.source));
        const sources = new Set(filtered.map((r) => r.source));
        if (sources.size >= 2) groups.push({ key: k, rows: filtered });
      }
      const sourcePairCounts = {};
      for (const g of groups) {
        const srcs = [...new Set(g.rows.map((r) => r.source))].sort();
        for (let i = 0; i < srcs.length; i++)
          for (let j = i + 1; j < srcs.length; j++) {
            const pair = `${srcs[i]} <-> ${srcs[j]}`;
            sourcePairCounts[pair] = (sourcePairCounts[pair] || 0) + 1;
          }
      }
      return {
        groups: groups.length,
        rows: groups.reduce((s, g) => s + g.rows.length, 0),
        sourcePairCounts,
      };
    }

    const crossSource = {
      whitelistOnly: crossSourceSummary((s) => WHITELIST.has(s)),
      anySourcePair: crossSourceSummary(() => true),
    };

    // ---- same-source (union-find by exact tech match, transitive) ----
    const bySourceKey = new Map();
    for (const r of rows) {
      const k = dupeKey(r.company, r.title);
      if (!k) continue;
      const sk = `${r.source}::${k}`;
      if (!bySourceKey.has(sk)) bySourceKey.set(sk, []);
      bySourceKey.get(sk).push(r);
    }

    const perSource = {};
    const highConfidenceClusters = [];
    const ambiguousSamples = [];
    for (const group of bySourceKey.values()) {
      if (group.length < 2) continue;
      const source = group[0].source;
      if (!perSource[source])
        perSource[source] = { keyGroups: 0, keyGroupRows: 0, exactDupeClusters: 0, exactDupeRows: 0, exactDupeToDelete: 0, ambiguousGroups: 0 };
      perSource[source].keyGroups += 1;
      perSource[source].keyGroupRows += group.length;

      const parent = group.map((_, i) => i);
      function find(i) { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; }
      function union(i, j) { const a = find(i), b = find(j); if (a !== b) parent[a] = b; }
      for (let i = 0; i < group.length; i++)
        for (let j = i + 1; j < group.length; j++)
          if (technologiesExactMatch(group[i].technologies, group[j].technologies)) union(i, j);

      const byRoot = new Map();
      group.forEach((r, i) => {
        const root = find(i);
        if (!byRoot.has(root)) byRoot.set(root, []);
        byRoot.get(root).push(r);
      });

      let anyExactCluster = false;
      for (const cluster of byRoot.values()) {
        if (cluster.length < 2) continue;
        anyExactCluster = true;
        perSource[source].exactDupeClusters += 1;
        perSource[source].exactDupeRows += cluster.length;
        perSource[source].exactDupeToDelete += cluster.length - 1;
        if (highConfidenceClusters.length < 40) {
          highConfidenceClusters.push({
            source,
            key: dupeKey(cluster[0].company, cluster[0].title),
            rows: cluster.map((r) => ({ id: r.id, url: r.url, technologies: r.technologies, active: r.active, first_seen: r.first_seen })),
          });
        }
      }
      if (!anyExactCluster) {
        perSource[source].ambiguousGroups += 1;
        if (ambiguousSamples.length < 15) {
          ambiguousSamples.push({
            source,
            key: dupeKey(group[0].company, group[0].title),
            rows: group.map((r) => ({ id: r.id, url: r.url, technologies: r.technologies, active: r.active, first_seen: r.first_seen })),
          });
        }
      }
    }

    return new Response(
      JSON.stringify(
        { totalRows: rows.length, bySource, crossSource, sameSource: { perSource, highConfidenceClusters, ambiguousSamples } },
        null,
        2
      ),
      { headers: { "Content-Type": "application/json" } }
    );
  } finally {
    client.release();
  }
};
