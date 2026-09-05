// Disposable one-off: cleans up wherewework same-source duplicates that the
// 2026-09-05 full-table audit/cleanup (tmp-full-dupe-audit.mjs /
// tmp-portal-dupe-cleanup.mjs, since removed) MISSED. Root cause found
// 2026-09-05 (live case: "HW Analysis Trainee" @ Bosch Magyarország):
// cron_jobs_DIAK_3-background.mjs's migrateByTitleCompany/
// hasActiveDuplicateByTitleCompany dedup check (added 2026-09-04) compares
// technologies for an EXACT match, but wherewework postings with an
// internship-style title (isInternshipTitle — "Trainee", "gyakornok", ...)
// take a fast path that sets experience="diákmunka" and never fetches
// item.technologies, so the check always compared undefined against the
// old row's real tag list and never matched — every repost of such a
// posting kept inserting as a fresh duplicate. Fixed at the source in
// cron_jobs_DIAK_3-background.mjs (fetch technologies before the dedup
// check runs, not only in the post-check backstop). This endpoint clears
// the duplicate rows the bug already created before that fix landed.
//
// Same-source (wherewework only), same dupeKey(company,title), where one
// side has NULL/empty technologies (the tell-tale sign of the bug above) or
// an exact technologies match (the class the prior cleanup already handled,
// re-checked here in case new ones appeared after it ran). Keeps whichever
// row in the cluster is currently `active` (falls back to earliest
// first_seen if none/more than one is active) so a live posting's url
// survives; deletes the rest. Never deletes a row marked applied/interview.
//
// mode=dryrun (default): report only. mode=commit: actually DELETE.
import { Pool } from "pg";
import { dupeKey, technologiesExactMatch } from "../../src/lib/crossSourceDupe.mjs";

const TOKEN = "tmp-wwtech-cleanup-7c2ea1";

const pool = new Pool({
  connectionString: process.env.NETLIFY_DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

function hasNoTech(t) {
  return t === null || t === undefined || String(t).trim() === "";
}

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
      `SELECT id, source, title, company, url, technologies, active, first_seen
       FROM job_posts
       WHERE source = 'wherewework'
         AND (active = true OR first_seen >= NOW() - INTERVAL '60 days')`
    );

    const byKey = new Map();
    for (const r of rows) {
      const k = dupeKey(r.company, r.title);
      if (!k) continue;
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(r);
    }

    const clusters = [];
    const toDelete = [];
    for (const group of byKey.values()) {
      if (group.length < 2) continue;

      // union-find: same-tech-set match OR either side has no tech at all
      const parent = group.map((_, i) => i);
      function find(i) { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; }
      function union(i, j) { const a = find(i), b = find(j); if (a !== b) parent[a] = b; }
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const same = technologiesExactMatch(group[i].technologies, group[j].technologies);
          const bridgeable = hasNoTech(group[i].technologies) || hasNoTech(group[j].technologies);
          if (same || bridgeable) union(i, j);
        }
      }

      const byRoot = new Map();
      group.forEach((r, i) => {
        const root = find(i);
        if (!byRoot.has(root)) byRoot.set(root, []);
        byRoot.get(root).push(r);
      });

      for (const cluster of byRoot.values()) {
        if (cluster.length < 2) continue;
        const activeRows = cluster.filter((r) => r.active);
        const survivor =
          activeRows.length === 1
            ? activeRows[0]
            : [...cluster].sort((a, b) => new Date(a.first_seen) - new Date(b.first_seen))[0];
        const losers = cluster.filter((r) => r.id !== survivor.id);
        clusters.push({
          key: dupeKey(survivor.company, survivor.title),
          keep: { id: survivor.id, url: survivor.url, active: survivor.active },
          drop: losers.map((r) => ({ id: r.id, url: r.url, active: r.active })),
        });
        for (const loser of losers) toDelete.push({ id: loser.id, url: loser.url });
      }
    }

    const { rows: appliedRows } = await client
      .query(`SELECT job_key FROM admin_applied_jobs WHERE (applied = true OR interview = true)`)
      .catch(() => ({ rows: [] }));
    const appliedUrls = new Set(appliedRows.map((r) => r.job_key.replace(/^job:[^:]+:/, "")));
    const safeDeletes = toDelete.filter((d) => !appliedUrls.has(d.url));
    const blockedDeletes = toDelete.filter((d) => appliedUrls.has(d.url));

    const result = {
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
