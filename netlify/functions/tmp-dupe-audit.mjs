// DISPOSABLE investigation endpoint — 2026-09-03, re-run of the cross-source
// duplicate audit after adding wherewework+nofluffjobs and the tech-overlap
// guard. Read-only, no DB writes. Delete after use.

import { Pool } from "pg";
import { dupeKey, isLikelySamePosting, CROSS_SOURCE_DUPE_SOURCES } from "../../src/lib/crossSourceDupe.mjs";

const TOKEN = "9a3f7c1e6b2d4058a1c9e7f3b62d0e58a3c7f19c";
const pool = new Pool({ connectionString: process.env.NETLIFY_DATABASE_URL, ssl: { rejectUnauthorized: false } });
const WHITELIST = new Set(CROSS_SOURCE_DUPE_SOURCES);

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

  const client = await pool.connect();
  try {
    const { rows } = await client.query(`
      SELECT source, company, title, url, active, technologies
      FROM job_posts
      WHERE company IS NOT NULL AND company <> ''
        AND title IS NOT NULL AND title <> ''
    `);

    // Group by raw dupeKey first (cheap), THEN sub-cluster each group by
    // isLikelySamePosting (title+company+tech-overlap) — same two-stage
    // approach as the frontend badge, so a generic-title collision (Deutsche
    // Telekom "DevOps Engineer" style) splits into separate clusters instead
    // of one false merge.
    const keyGroups = new Map();
    for (const r of rows) {
      const key = dupeKey(r.company, r.title);
      if (!key) continue;
      if (!keyGroups.has(key)) keyGroups.set(key, []);
      keyGroups.get(key).push(r);
    }

    let fullyCovered = 0;
    let flaggedButIncomplete = 0;
    let trueBlindSpot = 0;
    let splitByTech = 0; // key groups where clustering broke one dupeKey into >1 real cluster
    const pairCounts = new Map();
    const sampleBlindSpot = [];
    const samplePartial = [];
    const sampleSplitByTech = [];
    let totalClusters = 0;

    for (const [key, groupRows] of keyGroups) {
      const clusters = clusterByPosting(groupRows);
      if (clusters.length > 1) {
        splitByTech++;
        if (sampleSplitByTech.length < 15) {
          sampleSplitByTech.push({
            key,
            title: groupRows[0].title,
            company: groupRows[0].company,
            clusters: clusters.map((c) => c.map((r) => `${r.source} (${(r.technologies || "").split(",").filter(Boolean).length} tech): ${r.url}`)),
          });
        }
      }

      for (const cluster of clusters) {
        const sources = [...new Set(cluster.map((r) => r.source))];
        if (sources.length < 2) continue; // not a cross-source duplicate cluster
        totalClusters++;

        const sortedPair = [...sources].sort().join(" + ");
        pairCounts.set(sortedPair, (pairCounts.get(sortedPair) || 0) + 1);

        const inList = sources.filter((s) => WHITELIST.has(s));
        const outList = sources.filter((s) => !WHITELIST.has(s));

        if (outList.length === 0) {
          fullyCovered++;
        } else if (inList.length >= 2) {
          flaggedButIncomplete++;
          if (samplePartial.length < 20) {
            samplePartial.push({ key, title: cluster[0].title, company: cluster[0].company, sources, inList, outList });
          }
        } else {
          trueBlindSpot++;
          if (sampleBlindSpot.length < 40) {
            sampleBlindSpot.push({ key, title: cluster[0].title, company: cluster[0].company, sources, inList, outList });
          }
        }
      }
    }

    const topPairs = [...pairCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([pair, count]) => ({ pair, count }));
    const blindOutTally = {};
    for (const g of sampleBlindSpot) for (const s of g.outList) blindOutTally[s] = (blindOutTally[s] || 0) + 1;

    return new Response(
      JSON.stringify(
        {
          totalRowsScanned: rows.length,
          keyGroupsTotal: keyGroups.size,
          keyGroupsSplitByTech: splitByTech,
          totalCrossSourceClusters: totalClusters,
          fullyCovered,
          flaggedButIncomplete,
          trueBlindSpot,
          topSourcePairs: topPairs,
          blindSpotOutsideSourceTally: blindOutTally,
          sampleSplitByTech,
          samplePartiallyCovered: samplePartial,
          sampleBlindSpot,
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
