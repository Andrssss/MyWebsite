// Disposable full-table duplicate audit + cleanup, requested after issue #31's
// stats rebuild: duplication has been a recurring problem in this repo (see
// memory: cross-source-dupe-coverage.md) and the user wants the CURRENT
// duplicate backlog cleaned, using today's production matching logic, before
// the job-stats rebuild is considered final.
//
// Reuses the REAL production functions (not reimplemented): dupeKey() +
// technologiesExactMatch() from src/lib/crossSourceDupe.mjs — the same code
// every scraper's insert-time guard and the admin board's "Átfedés" badge use.
//
// Methodology (matches every prior cleanup pass in this repo's history, see
// the memory file above): full table, ANY pair, not limited to the insert-time
// whitelist (CROSS_SOURCE_DUPE_SOURCES only gates prevention, not what counts
// as a real dupe for cleanup). Group by dupeKey(company, title):
//   - group entirely within source "ats-crawl" → SKIPPED (Workday parallel
//     reqs with distinct real req-IDs can legitimately share a generic title;
//     established repo policy is manual-only for this case, never automatic).
//   - group spans exactly ONE non-ats-crawl source → same-source cluster,
//     only a real dupe sub-cluster when technologiesExactMatch() agrees
//     (bucketed by exact tag-set signature — rows with differing tag sets in
//     the same title+company group are treated as genuinely different reqs).
//   - group spans ≥2 distinct sources → cross-source cluster, key-only (no
//     tech check — established policy, cross-source tech-overlap was tried
//     and rejected by the user as "40% bullshit"). ats-crawl participating
//     alongside a genuinely different source is fine to include.
// For every confirmed cluster: keep the earliest first_seen row, union
// `technologies` onto it, OR its `active` flag across the cluster, delete the
// rest. Scope: live job_posts only (matches every prior cleanup in this
// repo — job-posts-archive was never in scope for this class of cleanup).
//
// GET = read-only audit. POST {"action":"execute"} = delete + full-history
// job-stats rebuild. Deploy, GET first, review, then POST execute, then
// remove this file.

import pkg from "pg";
const { Pool } = pkg;
import { dupeKey, technologiesExactMatch } from "../../src/lib/crossSourceDupe.mjs";
import { rebuildStats } from "./_stats_rebuild_core.mjs";

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

const TOKEN = "6a2f9c1d84e5b7038a1cfe25d09b6743a8215fc9e4b0d1a7";

function authorized(request) {
  const auth = request.headers.get("authorization") || "";
  return auth.replace(/^Bearer\s+/i, "").trim() === TOKEN;
}

function json(status, body) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function techSignature(technologies) {
  return (technologies ? String(technologies).split(",").map((t) => t.trim()).filter(Boolean) : [])
    .slice()
    .sort()
    .join(",");
}

// Returns array of { rows: [...], kind: "same-source" | "cross-source" }
function findClusters(allRows) {
  const byKey = new Map();
  for (const row of allRows) {
    const key = dupeKey(row.company, row.title);
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(row);
  }

  const clusters = [];
  for (const [key, rows] of byKey) {
    if (rows.length < 2) continue;
    const sources = new Set(rows.map((r) => r.source));

    if (sources.size === 1) {
      const onlySource = [...sources][0];
      if (onlySource === "ats-crawl") continue; // never automatic

      // Bucket by exact tech signature — only identical-signature buckets of
      // size >= 2 are real same-source duplicate clusters.
      const bySig = new Map();
      for (const row of rows) {
        const sig = techSignature(row.technologies);
        if (!bySig.has(sig)) bySig.set(sig, []);
        bySig.get(sig).push(row);
      }
      for (const bucket of bySig.values()) {
        if (bucket.length < 2) continue;
        // Sanity-confirm pairwise via the real function too (matches the
        // production isLikelySamePosting semantics exactly).
        const allMatch = bucket.every((r, i) =>
          i === 0 ? true : technologiesExactMatch(bucket[0].technologies, r.technologies)
        );
        if (allMatch) clusters.push({ key, kind: "same-source", rows: bucket });
      }
    } else {
      clusters.push({ key, kind: "cross-source", rows });
    }
  }
  return clusters;
}

function planCluster(cluster) {
  const sorted = [...cluster.rows].sort(
    (a, b) => new Date(a.first_seen) - new Date(b.first_seen)
  );
  const survivor = sorted[0];
  const toDelete = sorted.slice(1);
  const unionedTech = [
    ...new Set(
      cluster.rows.flatMap((r) =>
        r.technologies ? String(r.technologies).split(",").map((t) => t.trim()).filter(Boolean) : []
      )
    ),
  ].join(",");
  const anyActive = cluster.rows.some((r) => r.active);
  return { survivor, toDelete, unionedTech, anyActive };
}

async function runAudit(client) {
  const { rows } = await client.query(
    `SELECT id, source, url, title, company, technologies, active, first_seen FROM job_posts`
  );
  const clusters = findClusters(rows);
  const plans = clusters.map(planCluster);

  const bySourceKind = {};
  for (const c of clusters) {
    const label = c.kind === "cross-source" ? "cross-source" : [...new Set(c.rows.map((r) => r.source))][0];
    bySourceKind[label] = (bySourceKind[label] || 0) + 1;
  }

  return {
    totalLiveRows: rows.length,
    clusterCount: clusters.length,
    rowsToDelete: plans.reduce((n, p) => n + p.toDelete.length, 0),
    breakdown: bySourceKind,
    sample: clusters.slice(0, 40).map((c, i) => ({
      key: c.key,
      kind: c.kind,
      sources: [...new Set(c.rows.map((r) => r.source))],
      titles: c.rows.map((r) => ({ id: r.id, source: r.source, title: r.title, active: r.active, first_seen: r.first_seen, url: r.url })),
      keeps: plans[i].survivor.id,
      deletes: plans[i].toDelete.map((r) => r.id),
    })),
  };
}

async function runExecute(client) {
  const { rows } = await client.query(
    `SELECT id, source, url, title, company, technologies, active, first_seen FROM job_posts`
  );
  const clusters = findClusters(rows);
  const plans = clusters.map(planCluster);

  const deletedLog = [];
  for (const plan of plans) {
    const ids = plan.toDelete.map((r) => r.id);
    if (ids.length === 0) continue;
    await client.query(`DELETE FROM job_posts WHERE id = ANY($1::int[])`, [ids]);
    await client.query(
      `UPDATE job_posts SET technologies = $2, active = $3 WHERE id = $1`,
      [plan.survivor.id, plan.unionedTech, plan.anyActive]
    );
    deletedLog.push({
      survivorId: plan.survivor.id,
      survivorTitle: plan.survivor.title,
      deletedIds: ids,
      deletedTitles: plan.toDelete.map((r) => `${r.source}: ${r.title}`),
    });
  }

  const catRes = await client.query(`SELECT name, keywords FROM job_categories ORDER BY id`);
  const categories = catRes.rows.map((r) => [r.name, r.keywords]);
  const rebuild = await rebuildStats(client, categories, {});

  return {
    clustersProcessed: plans.filter((p) => p.toDelete.length > 0).length,
    totalRowsDeleted: deletedLog.reduce((n, d) => n + d.deletedIds.length, 0),
    deletedLog,
    rebuild: {
      from: rebuild.from,
      to: rebuild.to,
      days: rebuild.days,
      liveRows: rebuild.liveRows,
      archiveRows: rebuild.archiveRows,
      insertedStats: rebuild.insertedStats,
      insertedCategories: rebuild.insertedCategories,
      insertedLanguages: rebuild.insertedLanguages,
      insertedTechnologies: rebuild.insertedTechnologies,
      ms: rebuild.ms,
    },
  };
}

export default async (request) => {
  if (!authorized(request)) return json(401, { error: "unauthorized" });

  const client = await pool.connect();
  try {
    if (request.method === "POST") {
      let body = {};
      try {
        body = await request.json();
      } catch {
        // no/invalid body
      }
      if (body?.action === "execute") {
        return json(200, await runExecute(client));
      }
      return json(400, { error: "unknown POST action" });
    }
    return json(200, await runAudit(client));
  } finally {
    client.release();
  }
};
