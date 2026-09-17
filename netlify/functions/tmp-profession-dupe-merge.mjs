// DISPOSABLE — 2026-09-17. GH issue #20 cleanup: merges profession-intern
// rows that are the SAME posting re-slugged under a different legal-form
// spelling (or a "/pro" suffix variant) of the company name, confirmed by
// the identical trailing numeric profession ad id (the "extra certainty"
// check from the issue). Scoped ONLY to dupeKey groups where every member's
// ad id matches — groups sharing a dupeKey but with DIFFERENT ad ids (a
// separate, undiagnosed pattern: genuine re-posts under a brand-new id, or
// coincidental title+company collisions) are left untouched, out of scope
// for this narrow one-time cleanup (see tmp-profession-dupe-check.mjs's
// "professionGroups" output, 32/73 groups excluded this way).
//
// Per group: keeps the row with the earliest first_seen (preserves history),
// unions technologies from every member into it, sets active/sweep_dead to
// the truthful merged state (active if ANY member is currently active — do
// NOT blindly force active=true, since some groups are two independent
// dead-url observations of a posting that's actually gone), then deletes
// the other member rows. Delete this file (and its check sibling) after use.
import { Pool } from "pg";
import { dupeKey } from "../../src/lib/crossSourceDupe.mjs";

const TOKEN = "a48e0c916fd5b3a29e7c04f8d1b6935e08ac71f4d29b6c0e";
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

function splitTechList(technologies) {
  return technologies
    ? String(technologies).split(",").map((t) => t.trim()).filter(Boolean)
    : [];
}

function mergeTechnologies(members) {
  const allEmptyMarker = members.every((m) => m.technologies === "");
  if (allEmptyMarker) return "";
  const seen = new Set();
  const union = [];
  for (const m of members) {
    for (const t of splitTechList(m.technologies)) {
      if (!seen.has(t)) {
        seen.add(t);
        union.push(t);
      }
    }
  }
  return union.length > 0 ? union.join(", ") : null;
}

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });

  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT id, title, company, url, technologies, active, sweep_dead, first_seen
         FROM job_posts WHERE source = 'profession-intern'`
    );

    const groupsByKey = new Map();
    for (const r of rows) {
      const key = dupeKey(r.company, r.title);
      if (!key) continue;
      if (!groupsByKey.has(key)) groupsByKey.set(key, []);
      groupsByKey.get(key).push(r);
    }

    const results = [];
    for (const [key, members] of groupsByKey) {
      const distinctUrls = new Set(members.map((m) => m.url));
      if (distinctUrls.size < 2) continue;

      const ids = members.map((m) => adId(m.url));
      const sameAdId = ids.every((id) => id && id === ids[0]);
      if (!sameAdId) {
        results.push({ key, action: "skipped-ad-id-mismatch", adIds: ids });
        continue;
      }

      const sorted = members.slice().sort((a, b) => new Date(a.first_seen) - new Date(b.first_seen));
      const keep = sorted[0];
      const drop = sorted.slice(1);

      const mergedTechnologies = mergeTechnologies(sorted);
      const mergedActive = sorted.some((m) => m.active);
      const mergedSweepDead = mergedActive ? false : sorted.some((m) => m.sweep_dead);

      await client.query(
        `UPDATE job_posts SET technologies = $2, active = $3, sweep_dead = $4 WHERE id = $1`,
        [keep.id, mergedTechnologies, mergedActive, mergedSweepDead]
      );
      const dropIds = drop.map((m) => m.id);
      await client.query(`DELETE FROM job_posts WHERE id = ANY($1::int[])`, [dropIds]);

      results.push({
        key,
        action: "merged",
        keptId: keep.id,
        deletedIds: dropIds,
        technologiesBefore: sorted.map((m) => m.technologies),
        technologiesAfter: mergedTechnologies,
        active: mergedActive,
        sweep_dead: mergedSweepDead,
      });
    }

    const merged = results.filter((r) => r.action === "merged");
    const skipped = results.filter((r) => r.action === "skipped-ad-id-mismatch");
    return new Response(
      JSON.stringify(
        {
          mergedGroups: merged.length,
          rowsDeleted: merged.reduce((a, r) => a + r.deletedIds.length, 0),
          skippedGroups: skipped.length,
          results,
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
