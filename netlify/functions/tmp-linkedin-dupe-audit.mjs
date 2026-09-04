// Disposable read-only audit: LinkedIn same-source dupe-logic gaps.
import { Pool } from "pg";
import { dupeKey, normalizeDupeCompany, normalizeDupeTitle, technologiesExactMatch } from "../../src/lib/crossSourceDupe.mjs";

const TOKEN = "tmp-li-dupe-audit-6f2a91cd";

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
      `SELECT id, url, canonical_url, company, title, technologies, experience, level, first_seen
       FROM job_posts
       WHERE source = 'LinkedIn' AND active = true
         AND company IS NOT NULL AND company <> ''
         AND title IS NOT NULL AND title <> ''`
    );

    const { rows: canonStats } = await client.query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE canonical_url IS NULL)::int AS null_canonical
       FROM job_posts WHERE source = 'LinkedIn' AND active = true`
    );

    // Applied/interview-jobs linkage, so we never propose deleting a row the
    // admin has marked either way. job_key format is "job:<source>:<url>".
    const { rows: applied } = await client
      .query(`SELECT job_key, applied, interview FROM admin_applied_jobs WHERE job_key LIKE 'job:LinkedIn:%' AND (applied = true OR interview = true)`)
      .catch(() => ({ rows: [] }));
    const appliedUrls = new Set(applied.map((r) => r.job_key.replace(/^job:LinkedIn:/, "")));

    // 1) Same dupeKey (exact title+company match) but NOT deduped -> means
    //    technologiesExactMatch must have failed between them.
    const byKey = new Map();
    for (const r of rows) {
      const k = dupeKey(r.company, r.title);
      if (!k) continue;
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(r);
    }
    const sameKeyDupes = [...byKey.values()]
      .filter((g) => g.length > 1)
      .map((g) => ({
        key: dupeKey(g[0].company, g[0].title),
        sameJobId: (() => {
          const ids = g.map((r) => {
            const m = r.url.match(/-(\d+)(?:\?|$)/);
            return m ? m[1] : null;
          });
          return ids.every((id) => id && id === ids[0]);
        })(),
        rows: g.map((r) => ({
          id: r.id, url: r.url, canonical_url: r.canonical_url, company: r.company, title: r.title,
          technologies: r.technologies, experience: r.experience,
          first_seen: r.first_seen, applied: appliedUrls.has(r.url),
        })),
      }));

    // 2) Same normalized company + EXACT tech set, but title differs after
    //    normalization (candidate: HU/EN title-language reposts).
    const byCompanyTech = new Map();
    for (const r of rows) {
      const c = normalizeDupeCompany(r.company);
      if (!c) continue;
      const techSorted = (r.technologies || "")
        .split(",").map((t) => t.trim().toLowerCase()).filter(Boolean).sort().join("|");
      const k = `${c}::${techSorted}`;
      if (!byCompanyTech.has(k)) byCompanyTech.set(k, []);
      byCompanyTech.get(k).push(r);
    }
    const langVariantDupes = [...byCompanyTech.values()]
      .filter((g) => g.length > 1 && new Set(g.map((r) => normalizeDupeTitle(r.title))).size > 1)
      .filter((g) => g[0].technologies) // ignore empty-tech buckets, too noisy
      .map((g) => ({
        company: g[0].company,
        rows: g.map((r) => ({
          id: r.id, url: r.url, company: r.company, title: r.title,
          technologies: r.technologies, first_seen: r.first_seen,
          applied: appliedUrls.has(r.url),
        })),
      }));

    const { rows: eonRows } = await client.query(
      `SELECT id, url, active, company, title, technologies, first_seen
       FROM job_posts WHERE source = 'LinkedIn' AND company ILIKE '%e.on%'`
    );

    const { rows: scriptideRows } = await client.query(
      `SELECT id, url, canonical_url, active, company, title, technologies, experience, first_seen
       FROM job_posts WHERE source = 'LinkedIn' AND (company ILIKE '%scriptide%' OR title ILIKE '%scriptide%')`
    );

    return new Response(
      JSON.stringify(
        {
          eonRows,
          scriptideRows,
          totalActiveLinkedIn: rows.length,
          canonStats: canonStats[0],
          sameKeyDupeGroups: sameKeyDupes.length,
          sameJobIdDupeGroups: sameKeyDupes.filter((g) => g.sameJobId).length,
          sameKeyDupes,
          langVariantDupeGroups: langVariantDupes.length,
          langVariantDupes,
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
