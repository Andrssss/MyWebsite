// Disposable read-only audit: cross-source duplicate rows, NEW-whitelist
// scope (now includes workable/workly), full table (no active filter).
// Read-only. No writes.
import { Pool } from "pg";
import { dupeKey, CROSS_SOURCE_DUPE_SOURCES } from "../../src/lib/crossSourceDupe.mjs";

const TOKEN = "tmp-crosssource-audit2-9d4b7e";
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
      `SELECT id, source, title, company, url, first_seen, active
       FROM job_posts
       WHERE source = ANY($1::text[])`,
      [[...WHITELIST]]
    );

    const byKey = new Map();
    for (const r of rows) {
      const k = dupeKey(r.company, r.title);
      if (!k) continue;
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(r);
    }

    const groups = [];
    for (const [k, group] of byKey.entries()) {
      const sources = new Set(group.map((r) => r.source));
      if (sources.size < 2) continue;
      groups.push({ key: k, rows: group });
    }

    const toDelete = [];
    for (const g of groups) {
      const sorted = [...g.rows].sort((a, b) => new Date(a.first_seen) - new Date(b.first_seen));
      const keep = sorted[0];
      for (const loser of sorted.slice(1)) {
        toDelete.push({ id: loser.id, source: loser.source, keepId: keep.id, keepSource: keep.source, key: g.key });
      }
    }

    const { rows: appliedRows } = await client
      .query(`SELECT job_key FROM admin_applied_jobs WHERE (applied = true OR interview = true)`)
      .catch(() => ({ rows: [] }));
    const appliedKeys = new Set(appliedRows.map((r) => r.job_key));
    const urlById = new Map(rows.map((r) => [r.id, { source: r.source, url: r.url }]));
    const isApplied = (id) => {
      const u = urlById.get(id);
      return u && appliedKeys.has(`job:${u.source}:${u.url}`);
    };
    const safeDeletes = toDelete.filter((d) => !isApplied(d.id));
    const blockedDeletes = toDelete.filter((d) => isApplied(d.id));

    return new Response(
      JSON.stringify({ groups: groups.length, toDeleteCount: safeDeletes.length, blockedByAppliedFlag: blockedDeletes, toDelete: safeDeletes }, null, 2),
      { headers: { "Content-Type": "application/json" } }
    );
  } finally {
    client.release();
  }
};
