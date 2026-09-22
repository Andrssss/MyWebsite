// DISPOSABLE — 2026-09-22, GH issue #24 cleanup (leftover item from #26's
// checklist). Merges the 19 confirmed cross-source duplicate pairs found by
// tmp-issue24-verify.mjs (real dupeKey collisions between the 9 bank/
// single-company sources and another source — LinkedIn, profession-intern,
// zyntern, workly — that existed because the guard fix landed after these
// rows were already inserted). Same merge shape as GH issue #20's cleanup:
// keep the row with the earliest first_seen, union technologies from both,
// reconcile active/sweep_dead truthfully (active if EITHER row is active),
// delete the newer duplicate. Read-only "check" action + a "merge" action
// gated the same way. Delete after use.
import { Pool } from "pg";
import { dupeKey } from "../../src/lib/crossSourceDupe.mjs";

const TOKEN = "92e76228d8a3ef75e9b7ad15beae96f6628ca5ef5ce632eb";
const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

const BANK_SOURCES = ["mbh", "erste", "mfb", "raiffeisen", "unicredit", "kh", "cg-jobstream", "otp", "kuka"];

function unionTech(a, b) {
  const set = new Set();
  for (const t of [a, b]) {
    if (!t) continue;
    for (const part of String(t).split(",")) {
      const trimmed = part.trim();
      if (trimmed) set.add(trimmed);
    }
  }
  return set.size ? [...set].join(",") : null;
}

async function findGroups(client) {
  const { rows: bankRows } = await client.query(
    `SELECT id, source, title, url, company, active, sweep_dead, technologies, first_seen
       FROM job_posts
      WHERE source = ANY($1::text[])
        AND company IS NOT NULL AND company <> ''
        AND title IS NOT NULL AND title <> ''`,
    [BANK_SOURCES]
  );
  const { rows: otherRows } = await client.query(
    `SELECT id, source, title, url, company, active, sweep_dead, technologies, first_seen
       FROM job_posts
      WHERE source <> ALL($1::text[])
        AND company IS NOT NULL AND company <> ''
        AND title IS NOT NULL AND title <> ''`,
    [BANK_SOURCES]
  );
  const otherByKey = new Map();
  for (const r of otherRows) {
    const k = dupeKey(r.company, r.title);
    if (!k) continue;
    if (!otherByKey.has(k)) otherByKey.set(k, []);
    otherByKey.get(k).push(r);
  }
  const groups = [];
  const seenPairIds = new Set();
  for (const b of bankRows) {
    const k = dupeKey(b.company, b.title);
    if (!k) continue;
    const matches = otherByKey.get(k);
    if (!matches || !matches.length) continue;
    for (const m of matches) {
      const pairKey = [b.id, m.id].sort().join("-");
      if (seenPairIds.has(pairKey)) continue;
      seenPairIds.add(pairKey);
      groups.push({ key: k, rows: [b, m] });
    }
  }
  return groups;
}

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });

  const url = new URL(request.url);
  const action = url.searchParams.get("action") || "check";

  const client = await pool.connect();
  try {
    const groups = await findGroups(client);

    if (action === "check") {
      return new Response(
        JSON.stringify({ groupCount: groups.length, groups }, null, 2),
        { headers: { "content-type": "application/json; charset=utf-8" } }
      );
    }

    if (action === "merge") {
      const results = [];
      for (const g of groups) {
        const [r1, r2] = g.rows;
        const keep = new Date(r1.first_seen) <= new Date(r2.first_seen) ? r1 : r2;
        const drop = keep === r1 ? r2 : r1;

        const mergedTech = unionTech(keep.technologies, drop.technologies);
        const mergedActive = !!(keep.active || drop.active);
        const mergedSweepDead = !!(keep.sweep_dead && drop.sweep_dead);

        await client.query(
          `UPDATE job_posts SET technologies = $1, active = $2, sweep_dead = $3 WHERE id = $4`,
          [mergedTech, mergedActive, mergedSweepDead, keep.id]
        );
        const del = await client.query(`DELETE FROM job_posts WHERE id = $1`, [drop.id]);

        results.push({
          key: g.key,
          kept: { id: keep.id, source: keep.source, url: keep.url },
          deleted: { id: drop.id, source: drop.source, url: drop.url },
          deletedCount: del.rowCount,
        });
      }
      return new Response(
        JSON.stringify({ mergedCount: results.length, results }, null, 2),
        { headers: { "content-type": "application/json; charset=utf-8" } }
      );
    }

    return new Response("unknown action", { status: 400 });
  } finally {
    client.release();
  }
};
