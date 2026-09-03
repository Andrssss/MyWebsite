// DISPOSABLE investigation endpoint — 2026-09-03, cross-source duplicate
// coverage audit (how much of the real DB overlap does CROSS_SOURCE_DUPE_SOURCES
// actually catch). Read-only, no DB writes. Delete after use.

import { Pool } from "pg";
import { dupeKey, CROSS_SOURCE_DUPE_SOURCES } from "../../src/lib/crossSourceDupe.mjs";

const TOKEN = "2dce5c5f931e4dc361060b9ea418bdbe970f22b3";
const pool = new Pool({ connectionString: process.env.NETLIFY_DATABASE_URL, ssl: { rejectUnauthorized: false } });
const WHITELIST = new Set(CROSS_SOURCE_DUPE_SOURCES);

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) {
    return new Response("unauthorized", { status: 401 });
  }

  const client = await pool.connect();
  try {
    const { rows } = await client.query(`
      SELECT source, company, title, url, active
      FROM job_posts
      WHERE company IS NOT NULL AND company <> ''
        AND title IS NOT NULL AND title <> ''
    `);

    const groups = new Map();
    for (const r of rows) {
      const key = dupeKey(r.company, r.title);
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }

    const pairCounts = new Map();
    let fullyCovered = 0;
    let partiallyCovered = 0;
    let notCovered = 0;
    let flaggedButIncomplete = 0;
    let trueBlindSpot = 0;
    const sampleNotCovered = [];
    const samplePartial = [];
    const sampleBlindSpot = [];

    for (const [key, group] of groups) {
      const sources = [...new Set(group.map((r) => r.source))];
      if (sources.length < 2) continue;

      const inList = sources.filter((s) => WHITELIST.has(s));
      const outList = sources.filter((s) => !WHITELIST.has(s));

      const sortedPair = [...sources].sort().join(" + ");
      pairCounts.set(sortedPair, (pairCounts.get(sortedPair) || 0) + 1);

      if (outList.length === 0) {
        fullyCovered++;
      } else if (inList.length >= 2) {
        // Badge/guard still fires — at least 2 tracked sources remain in the
        // group even after the untracked one(s) are excluded from grouping.
        partiallyCovered++;
        flaggedButIncomplete++;
        if (samplePartial.length < 25) {
          samplePartial.push({
            key,
            title: group[0].title,
            company: group[0].company,
            sources,
            inList,
            outList,
            urls: group.map((r) => `${r.source}: ${r.url}`),
          });
        }
      } else if (inList.length === 1) {
        // Silent miss: only ONE tracked source is present, so the frontend's
        // own grouping (which drops untracked-source rows before counting
        // distinct sources) never sees >=2 members and never fires at all.
        partiallyCovered++;
        trueBlindSpot++;
        if (sampleBlindSpot.length < 60) {
          sampleBlindSpot.push({
            key,
            title: group[0].title,
            company: group[0].company,
            sources,
            inList,
            outList,
            urls: group.map((r) => `${r.source}: ${r.url}`),
          });
        }
      } else {
        notCovered++;
        if (sampleNotCovered.length < 25) {
          sampleNotCovered.push({
            key,
            title: group[0].title,
            company: group[0].company,
            sources,
            urls: group.map((r) => `${r.source}: ${r.url}`),
          });
        }
      }
    }

    const topPairs = [...pairCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 40)
      .map(([pair, count]) => ({ pair, count }));

    const sourceCounts = {};
    for (const r of rows) sourceCounts[r.source] = (sourceCounts[r.source] || 0) + 1;

    return new Response(
      JSON.stringify(
        {
          totalRowsScanned: rows.length,
          distinctSources: Object.keys(sourceCounts).length,
          sourceCounts,
          duplicateGroups: fullyCovered + partiallyCovered + notCovered,
          fullyCovered,
          partiallyCovered,
          flaggedButIncomplete,
          trueBlindSpot,
          notCoveredAtAll: notCovered,
          topSourcePairs: topPairs,
          samplePartiallyCovered: samplePartial,
          sampleBlindSpot,
          sampleNotCovered,
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
