// DISPOSABLE — 2026-09-16. Broader re-check for GH issue #18: the first pass
// (tmp-bank-dupe-check.mjs, already removed) required the OTHER source's
// `company` field to literally contain the bank's name, which misses a real
// duplicate where the aggregator scraped a blank/generic company. This pass
// uses the REAL production dupeKey() (imported, not reimplemented) across the
// WHOLE table — same method as the 2026-09-03/05/08 full-table dupe audits —
// so any row sharing a bank row's exact <company-first-word>|<norm-title> key
// shows up regardless of what the other source's company field says.
// Read-only. Delete after use.
import { Pool } from "pg";
import { dupeKey } from "../../src/lib/crossSourceDupe.mjs";

const TOKEN = "c74259b35fe934e06817a7a0b86c80040c208737eea17950";
const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

const BANK_SOURCES = ["mbh", "erste", "mfb", "raiffeisen", "unicredit", "kh", "cg-jobstream"];

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });

  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT id, source, company, title, url, active
         FROM job_posts
        WHERE company IS NOT NULL AND company <> ''
          AND title IS NOT NULL AND title <> ''`
    );

    const byKey = new Map();
    for (const r of rows) {
      const k = dupeKey(r.company, r.title);
      if (!k) continue;
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(r);
    }

    const clusters = [];
    for (const [key, group] of byKey) {
      const hasBank = group.some((r) => BANK_SOURCES.includes(r.source));
      const sources = new Set(group.map((r) => r.source));
      if (hasBank && sources.size > 1) {
        clusters.push({ key, rows: group });
      }
    }

    // Also: any bank row whose company/title look like a bank but source
    // itself is somehow NOT the expected one (sanity check for scraper bugs).
    const bankByTitleOnly = rows.filter(
      (r) =>
        !BANK_SOURCES.includes(r.source) &&
        /mbh|erste|raiffeisen|unicredit|k\s?&\s?h|capgemini|\bmfb\b/i.test(`${r.company} ${r.title}`)
    );

    return new Response(
      JSON.stringify(
        {
          totalRowsScanned: rows.length,
          exactKeyClusterCount: clusters.length,
          exactKeyClusters: clusters,
          otherSourceRowsMentioningBankNames: bankByTitleOnly,
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
