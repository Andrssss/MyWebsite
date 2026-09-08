// Disposable read-only check: any LinkedIn row whose stored canonical_url
// doesn't match what the CURRENT canonicalizeLinkedInJobUrl would compute
// from its url? (i.e. did the 2026-09-05 backfill miss anything, or has a
// new stale one appeared since).
import { Pool } from "pg";

const TOKEN = "tmp-canon-check-6a83fd";

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
      if (idMatch) return `https://www.linkedin.com/jobs/view/${idMatch[1]}`;
      const canonicalSlug = lastPart.replace(/-\d+$/, "");
      return `https://www.linkedin.com/jobs/view/${canonicalSlug}`;
    }
    return raw;
  } catch {
    return raw;
  }
}

export default async (req) => {
  const auth = req.headers.get("authorization") || "";
  if (auth.replace(/^Bearer\s+/i, "").trim() !== TOKEN) {
    return new Response("unauthorized", { status: 401 });
  }

  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT id, url, canonical_url, active, first_seen FROM job_posts WHERE source = 'LinkedIn'`
    );

    const stale = [];
    let hasNumericId = 0;
    let slugFallback = 0;
    for (const r of rows) {
      const fresh = canonicalizeLinkedInJobUrl(r.url);
      if (fresh !== r.canonical_url) {
        stale.push({ id: r.id, url: r.url, stored: r.canonical_url, fresh, active: r.active, first_seen: r.first_seen });
      }
      if (/\/jobs\/view\/\d+$/.test(fresh)) hasNumericId++;
      else slugFallback++;
    }

    return new Response(
      JSON.stringify(
        {
          totalLinkedInRows: rows.length,
          staleCount: stale.length,
          idBasedCanonicalCount: hasNumericId,
          slugFallbackCount: slugFallback,
          staleSample: stale.slice(0, 20),
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
