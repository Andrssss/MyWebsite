// DISPOSABLE — 2026-09-17. GH issue #20 cleanup pass 1 (read-only). Finds
// profession-intern rows sharing dupeKey(company, title) under different
// urls (the legal-form-slug re-slug / language-tag-drift bug), confirms the
// trailing numeric profession ad id also matches as extra certainty, and
// reports technologies diffs so the merge can be reviewed before writing.
// Also runs the same same-source dupeKey grouping across every OTHER source
// as a quick scope check (issue's "worth a quick full-table check" ask).
// Read-only, no writes. Delete this file after use.
import { Pool } from "pg";
import { dupeKey } from "../../src/lib/crossSourceDupe.mjs";

const TOKEN = "f3a91c7de6b84a2091f5c3ab7e0d48916b2c5a7f9013e6d8";
const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

function adId(url) {
  try {
    const path = new URL(url).pathname;
    const m = path.match(/-(\d+)(?:\/pro)?\/?$/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function groupByDupeKey(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = dupeKey(r.company, r.title);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const out = [];
  for (const [key, members] of groups) {
    const distinctUrls = new Set(members.map((m) => m.url));
    if (distinctUrls.size < 2) continue;
    out.push({ key, members });
  }
  return out;
}

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });

  const client = await pool.connect();
  try {
    const { rows: professionRows } = await client.query(
      `SELECT id, title, company, url, technologies, active, sweep_dead, first_seen
         FROM job_posts WHERE source = 'profession-intern'`
    );
    const professionGroups = groupByDupeKey(professionRows).map((g) => {
      const ids = g.members.map((m) => adId(m.url));
      const sameAdId = ids.every((id) => id && id === ids[0]);
      return {
        key: g.key,
        sameAdId,
        adIds: ids,
        members: g.members
          .slice()
          .sort((a, b) => new Date(a.first_seen) - new Date(b.first_seen))
          .map((m) => ({
            id: m.id,
            url: m.url,
            title: m.title,
            company: m.company,
            technologies: m.technologies,
            active: m.active,
            sweep_dead: m.sweep_dead,
            first_seen: m.first_seen,
          })),
      };
    });

    const { rows: sourceCounts } = await client.query(
      `SELECT source, COUNT(*) AS n FROM job_posts WHERE source <> 'profession-intern' GROUP BY source`
    );
    const scopeCheck = [];
    for (const { source } of sourceCounts) {
      const { rows } = await client.query(
        `SELECT id, title, company, url, first_seen FROM job_posts WHERE source = $1`,
        [source]
      );
      const groups = groupByDupeKey(rows);
      if (groups.length > 0) {
        scopeCheck.push({
          source,
          groupCount: groups.length,
          sample: groups.slice(0, 3).map((g) => ({
            key: g.key,
            urls: g.members.map((m) => m.url),
          })),
        });
      }
    }

    return new Response(
      JSON.stringify(
        {
          professionGroupCount: professionGroups.length,
          professionGroups,
          scopeCheck,
        },
        null,
        2
      ),
      { headers: { "content-type": "application/json; charset=utf-8" } }
    );
  } finally {
    client.release();
  }
};
