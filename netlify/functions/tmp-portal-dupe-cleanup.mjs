// Disposable one-off: clean up same-source (within-one-portal) duplicates
// found by tmp-full-dupe-audit.mjs — same title+company key, same source,
// EXACT technologies match (the same signal already trusted by
// findSameSourceDuplicate for LinkedIn). Excludes LinkedIn (already fixed
// via tmp-linkedin-canonical-fix). Union-find clusters rows within each
// (source, dupeKey) group by technologiesExactMatch (transitive since it's
// set equality), keeps the earliest first_seen per cluster, deletes the
// rest. Never deletes a row marked applied/interview.
//
// mode=dryrun (default): report only. mode=commit: actually DELETE.
import { Pool } from "pg";
import { dupeKey, technologiesExactMatch } from "../../src/lib/crossSourceDupe.mjs";

const TOKEN = "tmp-portal-cleanup-5b19fa";

const pool = new Pool({
  connectionString: process.env.NETLIFY_DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

export default async (req) => {
  const auth = req.headers.get("authorization") || "";
  if (auth.replace(/^Bearer\s+/i, "").trim() !== TOKEN) {
    return new Response("unauthorized", { status: 401 });
  }
  const url = new URL(req.url);
  const commit = url.searchParams.get("mode") === "commit";

  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT id, source, title, company, url, technologies, first_seen
       FROM job_posts
       WHERE source <> 'LinkedIn'
         AND (active = true OR first_seen >= NOW() - INTERVAL '30 days')`
    );

    const bySourceKey = new Map();
    for (const r of rows) {
      const k = dupeKey(r.company, r.title);
      if (!k) continue;
      const sk = `${r.source}::${k}`;
      if (!bySourceKey.has(sk)) bySourceKey.set(sk, []);
      bySourceKey.get(sk).push(r);
    }

    const toDelete = [];
    const clusters = [];
    for (const group of bySourceKey.values()) {
      if (group.length < 2) continue;
      // union-find by exact tech match (transitive: it's set equality)
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

      for (const cluster of byRoot.values()) {
        if (cluster.length < 2) continue;
        const sorted = [...cluster].sort((a, b) => new Date(a.first_seen) - new Date(b.first_seen));
        clusters.push({ source: sorted[0].source, key: dupeKey(sorted[0].company, sorted[0].title), keep: sorted[0].id, drop: sorted.slice(1).map((r) => r.id) });
        for (const loser of sorted.slice(1)) toDelete.push({ id: loser.id, source: loser.source, url: loser.url, keptId: sorted[0].id });
      }
    }

    const { rows: appliedRows } = await client
      .query(`SELECT job_key FROM admin_applied_jobs WHERE (applied = true OR interview = true)`)
      .catch(() => ({ rows: [] }));
    const appliedUrls = new Set(
      appliedRows.map((r) => r.job_key.replace(/^job:[^:]+:/, ""))
    );
    const safeDeletes = toDelete.filter((d) => !appliedUrls.has(d.url));
    const blockedDeletes = toDelete.filter((d) => appliedUrls.has(d.url));

    let result = {
      mode: commit ? "commit" : "dryrun",
      clusterGroups: clusters.length,
      rowsToDelete: safeDeletes.length,
      blockedByAppliedFlag: blockedDeletes,
      byCluster: clusters,
    };

    if (commit) {
      await client.query("BEGIN");
      try {
        for (const d of safeDeletes) {
          await client.query(`DELETE FROM job_posts WHERE id = $1`, [d.id]);
        }
        await client.query("COMMIT");
        result.committed = true;
      } catch (err) {
        await client.query("ROLLBACK");
        result.committed = false;
        result.error = err.message;
      }
    }

    return new Response(JSON.stringify(result, null, 2), { headers: { "Content-Type": "application/json" } });
  } finally {
    client.release();
  }
};
