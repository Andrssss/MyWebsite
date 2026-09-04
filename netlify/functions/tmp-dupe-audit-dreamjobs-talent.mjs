// DISPOSABLE, READ-ONLY audit endpoint — 2026-09-04.
//
// Purpose: find duplicates left behind by the OLD behavior that this
// session's changes just fixed:
//   (1) dreamjobs same-source dupes (dreamjobs had NO same-source guard at
//       all before today) — tech-aware clustering, same rule
//       findSameSourceDuplicate enforces going forward.
//   (2) cross-source dupes touching dreamjobs (dreamjobs was outside
//       CROSS_SOURCE_DUPE_SOURCES until today).
//   (3) cross-source dupes touching talent (talent was in the whitelist as a
//       comparison target, but its OWN scraper never called
//       loadCrossSourceDupeIndex against it, so nothing ever skipped an
//       insert on talent's side).
//
// No writes anywhere — report only, for human review before any cleanup.
// Delete this file after use.

import { Pool } from "pg";
import { dupeKey, isLikelySamePosting, CROSS_SOURCE_DUPE_SOURCES } from "../../src/lib/crossSourceDupe.mjs";

const TOKEN = "b7f2c9e14a6d8031f5e7c2a90b4d6f18c3a5e7b9";
const pool = new Pool({ connectionString: process.env.NETLIFY_DATABASE_URL, ssl: { rejectUnauthorized: false } });

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
  return [...clusters.values()].filter((c) => c.length > 1);
}

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) {
    return new Response("unauthorized", { status: 401 });
  }

  const client = await pool.connect();
  try {
    const { rows: dreamRows } = await client.query(
      `SELECT id, url, company, title, technologies, first_seen
         FROM job_posts
        WHERE source = 'dreamjobs' AND active = true
          AND company IS NOT NULL AND company <> ''
          AND title IS NOT NULL AND title <> ''`
    );
    const dreamGroups = new Map();
    for (const r of dreamRows) {
      const key = dupeKey(r.company, r.title);
      if (!key) continue;
      if (!dreamGroups.has(key)) dreamGroups.set(key, []);
      dreamGroups.get(key).push(r);
    }
    const dreamjobsSameSource = [];
    for (const [key, groupRows] of dreamGroups) {
      for (const cluster of clusterByPosting(groupRows)) {
        const sorted = [...cluster].sort((a, b) => new Date(a.first_seen) - new Date(b.first_seen));
        dreamjobsSameSource.push({
          key,
          title: sorted[0].title,
          company: sorted[0].company,
          rows: sorted.map((r) => ({ url: r.url, first_seen: r.first_seen, technologies: r.technologies })),
        });
      }
    }

    const { rows: allRows } = await client.query(
      `SELECT source, url, company, title, first_seen
         FROM job_posts
        WHERE active = true
          AND source = ANY($1::text[])
          AND company IS NOT NULL AND company <> ''
          AND title IS NOT NULL AND title <> ''`,
      [CROSS_SOURCE_DUPE_SOURCES]
    );
    const crossGroups = new Map();
    for (const r of allRows) {
      const key = dupeKey(r.company, r.title);
      if (!key) continue;
      if (!crossGroups.has(key)) crossGroups.set(key, []);
      crossGroups.get(key).push(r);
    }
    const dreamjobsCrossSource = [];
    const talentCrossSource = [];
    for (const [key, groupRows] of crossGroups) {
      const sources = new Set(groupRows.map((r) => r.source));
      if (sources.size < 2) continue;
      const entry = {
        key,
        title: groupRows[0].title,
        company: groupRows[0].company,
        rows: groupRows.map((r) => ({ source: r.source, url: r.url, first_seen: r.first_seen })),
      };
      if (sources.has("dreamjobs")) dreamjobsCrossSource.push(entry);
      if (sources.has("talent")) talentCrossSource.push(entry);
    }

    return new Response(
      JSON.stringify(
        {
          dreamjobsSameSource,
          dreamjobsCrossSource,
          talentCrossSource,
          counts: {
            dreamjobsSameSourceClusters: dreamjobsSameSource.length,
            dreamjobsCrossSourceClusters: dreamjobsCrossSource.length,
            talentCrossSourceClusters: talentCrossSource.length,
          },
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
