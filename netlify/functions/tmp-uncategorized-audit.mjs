// DISPOSABLE, READ-ONLY audit endpoint — 2026-09-04.
//
// Purpose: last-30-days active postings that land in the UNCATEGORIZED
// ("Egyéb") bucket via src/lib/categorize.mjs, plus a title-word frequency
// breakdown, so a human can spot patterns worth a job_filters addition.
// No writes anywhere. Delete this file after use.

import { Pool } from "pg";
import { categorize, UNCATEGORIZED } from "../../src/lib/categorize.mjs";

const TOKEN = "d94f1c7a2e6b83051f9d4c7a6e2b90f3c5a7e1b8";
const pool = new Pool({ connectionString: process.env.NETLIFY_DATABASE_URL, ssl: { rejectUnauthorized: false } });

const STOPWORDS = new Set([
  "és", "a", "az", "kft", "zrt", "bt", "senior", "junior", "medior", "mid",
  "level", "i", "ii", "iii", "1", "2", "3", "full", "time", "part",
]);

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) {
    return new Response("unauthorized", { status: 401 });
  }

  const client = await pool.connect();
  try {
    const { rows: catRows } = await client.query(`SELECT name, keywords FROM job_categories ORDER BY id`);
    const categories = catRows.map((r) => [r.name, r.keywords]);

    const { rows: filterRows } = await client.query(`SELECT word FROM job_filters ORDER BY word`);
    const filters = filterRows.map((r) => r.word);

    const { rows } = await client.query(
      `SELECT source, url, company, title, first_seen
         FROM job_posts
        WHERE active = true
          AND first_seen >= now() - interval '30 days'
          AND title IS NOT NULL AND title <> ''`
    );

    const uncategorized = [];
    const bySource = new Map();
    const wordFreq = new Map();

    for (const r of rows) {
      const cat = categorize(r.title, categories);
      if (cat !== UNCATEGORIZED) continue;
      uncategorized.push({
        source: r.source,
        url: r.url,
        company: r.company,
        title: r.title,
        first_seen: r.first_seen,
      });
      bySource.set(r.source, (bySource.get(r.source) || 0) + 1);
      const words = r.title
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .split(/\s+/)
        .filter((w) => w.length > 2 && !STOPWORDS.has(w));
      for (const w of words) wordFreq.set(w, (wordFreq.get(w) || 0) + 1);
    }

    const topWords = [...wordFreq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 80)
      .map(([word, count]) => ({ word, count }));

    return new Response(
      JSON.stringify(
        {
          totalActiveLast30d: rows.length,
          uncategorizedCount: uncategorized.length,
          bySource: Object.fromEntries([...bySource.entries()].sort((a, b) => b[1] - a[1])),
          topWords,
          existingFilterWordCount: filters.length,
          uncategorized,
        },
        null,
        2
      ),
      { headers: { "content-type": "application/json" } }
    );
  } finally {
    client.release();
  }
};
