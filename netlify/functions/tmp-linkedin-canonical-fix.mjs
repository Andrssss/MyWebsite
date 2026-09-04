// Disposable one-off fix: recompute canonical_url for every LinkedIn row with
// the CURRENT canonicalizeLinkedInJobUrl (old rows kept whatever value was
// computed at insert time under an older version of that function — the
// slug-based fallback, before it switched to id-based canonicalization — so
// they never match a fresh id-based canonical for the same job resurfacing
// later, and both the in-memory + SQL "already known" guards in
// _linkedin_core.mjs miss it -> duplicate row). Then, among ACTIVE rows that
// now share a canonical_url, keep the one with the richer `technologies`
// extraction (tie-break: earlier first_seen) and delete the rest.
//
// mode=dryrun (default): report only, no writes.
// mode=commit: actually UPDATE canonical_url and DELETE the losing duplicates.
import { Pool } from "pg";

const TOKEN = "tmp-li-canon-fix-3d81ef04";

const pool = new Pool({
  connectionString: process.env.NETLIFY_DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

function canonicalizeLinkedInJobUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.hostname.includes("linkedin.com") && u.pathname.startsWith("/jobs/view/")) {
      const lastPart = u.pathname.split("/jobs/view/")[1];
      const idMatch = lastPart.match(/-(\d+)\/?$/);
      if (idMatch) {
        return `https://www.linkedin.com/jobs/view/${idMatch[1]}`;
      }
      const canonicalSlug = lastPart.replace(/-\d+$/, "");
      return `https://www.linkedin.com/jobs/view/${canonicalSlug}`;
    }
    return raw;
  } catch {
    return raw;
  }
}

function techLen(t) {
  if (!t) return 0;
  return t.split(",").map((s) => s.trim()).filter(Boolean).length;
}

export default async (req) => {
  const auth = req.headers.get("authorization") || "";
  if (auth.replace(/^Bearer\s+/i, "").trim() !== TOKEN) {
    return new Response("unauthorized", { status: 401 });
  }
  const url = new URL(req.url);
  const commit = url.searchParams.get("mode") === "commit";

  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT id, url, canonical_url, active, technologies, first_seen
       FROM job_posts WHERE source = 'LinkedIn'`
    );

    let canonUpdates = [];
    for (const r of rows) {
      const fresh = canonicalizeLinkedInJobUrl(r.url);
      if (fresh !== r.canonical_url) {
        canonUpdates.push({ id: r.id, old: r.canonical_url, fresh });
      }
    }

    // Group by FRESH canonical_url among ACTIVE rows to find dupes that would
    // exist once canonical_url is corrected.
    const byFreshCanon = new Map();
    for (const r of rows) {
      if (!r.active) continue;
      const fresh = canonicalizeLinkedInJobUrl(r.url);
      if (!byFreshCanon.has(fresh)) byFreshCanon.set(fresh, []);
      byFreshCanon.get(fresh).push(r);
    }
    const dupeGroups = [...byFreshCanon.entries()].filter(([, g]) => g.length > 1);

    const toDelete = [];
    const toKeep = [];
    for (const [canon, group] of dupeGroups) {
      const sorted = [...group].sort(
        (a, b) => techLen(b.technologies) - techLen(a.technologies) || new Date(a.first_seen) - new Date(b.first_seen)
      );
      toKeep.push(sorted[0].id);
      for (const loser of sorted.slice(1)) toDelete.push({ id: loser.id, canonical_url: canon, keptId: sorted[0].id });
    }

    // Safety: never delete a row admin has marked applied/interview.
    const { rows: appliedRows } = await client
      .query(`SELECT job_key FROM admin_applied_jobs WHERE job_key LIKE 'job:LinkedIn:%' AND (applied = true OR interview = true)`)
      .catch(() => ({ rows: [] }));
    const appliedUrls = new Set(appliedRows.map((r) => r.job_key.replace(/^job:LinkedIn:/, "")));
    const urlById = new Map(rows.map((r) => [r.id, r.url]));
    const blockedDeletes = toDelete.filter((d) => appliedUrls.has(urlById.get(d.id)));
    const safeDeletes = toDelete.filter((d) => !appliedUrls.has(urlById.get(d.id)));

    let result = {
      mode: commit ? "commit" : "dryrun",
      canonicalUpdatesNeeded: canonUpdates.length,
      dupeGroupsFound: dupeGroups.length,
      rowsToDelete: safeDeletes.length,
      blockedByAppliedFlag: blockedDeletes,
      sampleDeletes: safeDeletes.slice(0, 5),
    };

    if (commit) {
      await client.query("BEGIN");
      try {
        for (const u of canonUpdates) {
          await client.query(`UPDATE job_posts SET canonical_url = $1 WHERE id = $2`, [u.fresh, u.id]);
        }
        for (const d of safeDeletes) {
          await client.query(`DELETE FROM job_posts WHERE id = $1`, [d.id]);
        }
        await client.query("COMMIT");
        result.committed = true;
      } catch (err) {
        await client.query("ROLLBACK");
        result.committed = false;
        result.error = err.message;
      }
    }

    return new Response(JSON.stringify(result, null, 2), { headers: { "Content-Type": "application/json" } });
  } finally {
    client.release();
  }
};
