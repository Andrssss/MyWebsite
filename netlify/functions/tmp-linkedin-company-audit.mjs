// DISPOSABLE, READ-ONLY audit endpoint — 2026-09-04.
//
// All active LinkedIn rows grouped by normalized company only (no title
// matching at all) so a human can spot near-duplicate titles that the exact
// dupeKey (company+title) match would miss. No writes. Delete after use.

import { Pool } from "pg";
import { normalizeDupeCompany } from "../../src/lib/crossSourceDupe.mjs";

const TOKEN = "b7f2c9e14a6d8031f5e7c2a90b4d6f18c3a5e7b9";
const pool = new Pool({ connectionString: process.env.NETLIFY_DATABASE_URL, ssl: { rejectUnauthorized: false } });

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });

  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT id, url, title, company, technologies, first_seen
         FROM job_posts
        WHERE source = 'LinkedIn'
          AND active = true
          AND company IS NOT NULL AND company <> ''`
    );

    const groups = new Map();
    for (const r of rows) {
      const key = normalizeDupeCompany(r.company);
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }

    const multi = [...groups.entries()]
      .filter(([, rs]) => rs.length > 1)
      .map(([key, rs]) => ({
        companyKey: key,
        count: rs.length,
        rows: rs.map((r) => ({ id: r.id, title: r.title, url: r.url, technologies: r.technologies, first_seen: r.first_seen })),
      }))
      .sort((a, b) => b.count - a.count);

    return new Response(JSON.stringify({ totalActiveRows: rows.length, companiesWithMultiple: multi.length, groups: multi }, null, 2), {
      headers: { "content-type": "application/json" },
    });
  } finally {
    client.release();
  }
};
