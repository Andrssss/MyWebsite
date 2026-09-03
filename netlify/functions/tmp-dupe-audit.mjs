// DISPOSABLE investigation endpoint — 2026-09-03, checking why the live SEON
// "Test Engineer" LinkedIn/ats-crawl pair isn't getting the Átfedés badge
// despite the matching logic simulating a match offline. Read-only. Delete after use.

import { Pool } from "pg";
import { dupeKey, technologyOverlap, isLikelySamePosting } from "../../src/lib/crossSourceDupe.mjs";

const TOKEN = "6abedc96b32fd68884e58bd89ba2db3ffee15e4f";
const pool = new Pool({ connectionString: process.env.NETLIFY_DATABASE_URL, ssl: { rejectUnauthorized: false } });

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) {
    return new Response("unauthorized", { status: 401 });
  }

  const client = await pool.connect();
  try {
    const { rows } = await client.query(`
      SELECT source, company, title, technologies, url, active, first_seen
      FROM job_posts
      WHERE company ILIKE '%seon%' AND title ILIKE '%test engineer%'
      ORDER BY first_seen DESC
    `);

    const enriched = rows.map((r) => ({
      source: r.source,
      company: r.company,
      companyLength: r.company ? r.company.length : null,
      companyCharCodes: r.company ? [...r.company].map((c) => c.charCodeAt(0)) : null,
      title: r.title,
      titleLength: r.title ? r.title.length : null,
      technologies: r.technologies,
      technologiesLength: r.technologies ? r.technologies.length : null,
      dupeKey: dupeKey(r.company, r.title),
      active: r.active,
      url: r.url,
      first_seen: r.first_seen,
    }));

    let pairwise = null;
    if (rows.length >= 2) {
      pairwise = [];
      for (let i = 0; i < rows.length; i++) {
        for (let j = i + 1; j < rows.length; j++) {
          pairwise.push({
            a: `${rows[i].source}: ${rows[i].url}`,
            b: `${rows[j].source}: ${rows[j].url}`,
            keyA: dupeKey(rows[i].company, rows[i].title),
            keyB: dupeKey(rows[j].company, rows[j].title),
            overlap: technologyOverlap(rows[i].technologies, rows[j].technologies),
            isLikelySamePosting: isLikelySamePosting(rows[i], rows[j]),
          });
        }
      }
    }

    return new Response(JSON.stringify({ count: rows.length, rows: enriched, pairwise }, null, 2), {
      headers: { "content-type": "application/json" },
    });
  } finally {
    client.release();
  }
};
