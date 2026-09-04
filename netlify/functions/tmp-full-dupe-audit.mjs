// Disposable read-only audit: full-table duplicate scan.
//  - crossSource: dupeKey (company|title) collisions spanning >=2 DIFFERENT
//    sources, both restricted to the current CROSS_SOURCE_DUPE_SOURCES
//    whitelist (what the frontend badge shows) and unrestricted (any source
//    pair at all, to see if the whitelist is missing a real overlap).
//  - sameSource: dupeKey collisions within a SINGLE source (>=2 rows, same
//    source, same normalized title+company) — the LinkedIn bug class,
//    checked here across every other source too. Each group is tagged
//    techMatch (technologiesExactMatch true -> high-confidence real repost/
//    dupe) vs techMismatch (different tags -> could be a genuine distinct
//    req, needs human judgement, same caution as the Deutsche Telekom case).
// Read-only. No writes performed.
import { Pool } from "pg";
import {
  dupeKey,
  CROSS_SOURCE_DUPE_SOURCES,
  technologiesExactMatch,
} from "../../src/lib/crossSourceDupe.mjs";

const TOKEN = "tmp-full-dupe-audit-9c72e1";
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
       FROM job_posts
       WHERE active = true OR first_seen >= NOW() - INTERVAL '30 days'`
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
        sample: groups.slice(0, 8).map((g) => ({
          key: g.key,
          rows: g.rows.map((r) => ({ id: r.id, source: r.source, title: r.title, company: r.company, url: r.url })),
        })),
      };
    }

    const crossSource = {
      whitelistOnly: crossSourceSummary((s) => WHITELIST.has(s)),
      anySourcePair: crossSourceSummary(() => true),
    };

    // ---- same-source ----
    const bySourceKey = new Map();
    for (const r of rows) {
      const k = dupeKey(r.company, r.title);
      if (!k) continue;
      const sk = `${r.source}::${k}`;
      if (!bySourceKey.has(sk)) bySourceKey.set(sk, []);
      bySourceKey.get(sk).push(r);
    }

    const perSource = {};
    const highConfidenceSamples = [];
    const ambiguousSamples = [];
    for (const [sk, group] of bySourceKey.entries()) {
      if (group.length < 2) continue;
      const source = group[0].source;
      if (!perSource[source]) perSource[source] = { groups: 0, rows: 0, techMatchGroups: 0, techMismatchGroups: 0 };
      perSource[source].groups += 1;
      perSource[source].rows += group.length;

      // Pairwise: does ANY pair in this group have an exact tech match?
      let anyTechMatch = false;
      for (let i = 0; i < group.length; i++)
        for (let j = i + 1; j < group.length; j++)
          if (technologiesExactMatch(group[i].technologies, group[j].technologies)) anyTechMatch = true;

      if (anyTechMatch) {
        perSource[source].techMatchGroups += 1;
        if (highConfidenceSamples.length < 10)
          highConfidenceSamples.push({
            source,
            rows: group.map((r) => ({ id: r.id, title: r.title, company: r.company, url: r.url, technologies: r.technologies, first_seen: r.first_seen })),
          });
      } else {
        perSource[source].techMismatchGroups += 1;
        if (ambiguousSamples.length < 10)
          ambiguousSamples.push({
            source,
            rows: group.map((r) => ({ id: r.id, title: r.title, company: r.company, url: r.url, technologies: r.technologies, first_seen: r.first_seen })),
          });
      }
    }

    return new Response(
      JSON.stringify(
        {
          totalRows: rows.length,
          bySource,
          crossSource,
          sameSource: { perSource, highConfidenceSamples, ambiguousSamples },
        },
        null,
        2
      ),
      { headers: { "Content-Type": "application/json" } }
    );
  } finally {
    client.release();
  }
};
