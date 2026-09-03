// DISPOSABLE investigation endpoint — 2026-09-03, forward-looking robustness
// check on the cross-source dupe filters: (1) how clean is the 0.4 Jaccard
// cutoff (histogram of scores near the boundary), (2) how exposed is the
// ats-crawl/startupjobs/workable key-only-at-check-time path to the exact
// generic-title collision the tech-overlap guard was built for. Read-only,
// no DB writes. Delete after use.

import { Pool } from "pg";
import { dupeKey, technologyOverlap, isLikelySamePosting, CROSS_SOURCE_DUPE_SOURCES } from "../../src/lib/crossSourceDupe.mjs";

const TOKEN = "5e1b8a4f9c3d6072b4e8a1f5c93d1f69b4d8f2ac";
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
      SELECT source, company, title, url, technologies
      FROM job_posts
      WHERE company IS NOT NULL AND company <> ''
        AND title IS NOT NULL AND title <> ''
    `);

    const keyGroups = new Map();
    for (const r of rows) {
      const key = dupeKey(r.company, r.title);
      if (!key) continue;
      if (!keyGroups.has(key)) keyGroups.set(key, []);
      keyGroups.get(key).push(r);
    }

    // 1) Jaccard score histogram — every pair WITHIN a same-key group that has
    // technologies on both sides (skip null/undetermined pairs). Buckets of
    // 0.05 so the region right around 0.4 is visible.
    const histogram = {};
    const nearThreshold = []; // pairs scoring within +/-0.1 of 0.4 either side
    for (const groupRows of keyGroups.values()) {
      if (groupRows.length < 2) continue;
      for (let i = 0; i < groupRows.length; i++) {
        for (let j = i + 1; j < groupRows.length; j++) {
          const a = groupRows[i], b = groupRows[j];
          if (a.source === b.source) continue; // same-source noise not relevant here
          const overlap = technologyOverlap(a.technologies, b.technologies);
          if (overlap === null) continue;
          const bucket = (Math.floor(overlap / 0.05) * 0.05).toFixed(2);
          histogram[bucket] = (histogram[bucket] || 0) + 1;
          if (overlap >= 0.3 && overlap <= 0.5) {
            nearThreshold.push({
              overlap: Number(overlap.toFixed(3)),
              company: a.company,
              title: a.title,
              sourceA: a.source,
              sourceB: b.source,
              urlA: a.url,
              urlB: b.url,
            });
          }
        }
      }
    }
    nearThreshold.sort((x, y) => x.overlap - y.overlap);

    // 2) ats-crawl-style exposure: among the keys that genuinely split into
    // >=2 real postings by tech-overlap, how many have >=2 members drawn from
    // WHITELIST sources? Those are exactly the keys where a key-only check
    // (ats-crawl's own dupe check, run before it has technologies) would
    // still wrongly treat a brand-new, genuinely different posting as a dupe
    // of something already in the index, because it can't apply the same
    // tech-overlap split ats-crawl's own stored rows benefit from once
    // inserted.
    let splitGroupsExposedToKeyOnlyCallers = 0;
    const exposedSamples = [];
    for (const [key, groupRows] of keyGroups) {
      const clusters = clusterByPosting(groupRows);
      if (clusters.length < 2) continue;
      const whitelistMemberCount = groupRows.filter((r) => WHITELIST.has(r.source)).length;
      if (whitelistMemberCount >= 2) {
        splitGroupsExposedToKeyOnlyCallers++;
        if (exposedSamples.length < 20) {
          exposedSamples.push({
            key,
            title: groupRows[0].title,
            company: groupRows[0].company,
            clusters: clusters.map((c) => c.map((r) => r.source)),
          });
        }
      }
    }

    return new Response(
      JSON.stringify(
        {
          totalRowsScanned: rows.length,
          jaccardHistogram: histogram,
          nearThresholdPairsCount: nearThreshold.length,
          nearThresholdSample: nearThreshold.slice(0, 30),
          splitGroupsExposedToKeyOnlyCallers,
          exposedSamples,
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
