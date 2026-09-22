// DISPOSABLE — 2026-09-22, GH issue #24 verification (leftover item from #26's
// checklist). Confirms whether the bank/single-company-portal dupe guard fix
// (SMALL_COMPANY_DUPE_SOURCES in src/lib/crossSourceDupe.mjs, `cebd6b7` +
// `62bb2ed`) actually leaves no live cross-source duplicates for these 9
// sources, using the REAL production dupeKey() (imported, not reimplemented)
// so this measures the actual matching definition, not an approximation.
// Read-only. Delete after use.
import { Pool } from "pg";
import { dupeKey } from "../../src/lib/crossSourceDupe.mjs";

const TOKEN = "92e76228d8a3ef75e9b7ad15beae96f6628ca5ef5ce632eb";
const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

const BANK_SOURCES = ["mbh", "erste", "mfb", "raiffeisen", "unicredit", "kh", "cg-jobstream", "otp", "kuka"];

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });

  const client = await pool.connect();
  try {
    const { rows: bankRows } = await client.query(
      `SELECT source, id, title, url, company, active
         FROM job_posts
        WHERE source = ANY($1::text[])
          AND company IS NOT NULL AND company <> ''
          AND title IS NOT NULL AND title <> ''`,
      [BANK_SOURCES]
    );

    const { rows: emptyCompanyRows } = await client.query(
      `SELECT source, COUNT(*)::int AS count
         FROM job_posts
        WHERE source = ANY($1::text[]) AND (company IS NULL OR company = '')
        GROUP BY source`,
      [BANK_SOURCES]
    );

    const { rows: otherRows } = await client.query(
      `SELECT source, id, title, url, company, active
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

    const collisions = [];
    for (const b of bankRows) {
      const k = dupeKey(b.company, b.title);
      if (!k) continue;
      const matches = otherByKey.get(k);
      if (matches && matches.length) {
        collisions.push({ key: k, bank: b, matches });
      }
    }

    return new Response(
      JSON.stringify(
        {
          bankSourcesChecked: BANK_SOURCES,
          bankRowCount: bankRows.length,
          emptyCompanyStillPresent: emptyCompanyRows,
          collisionCount: collisions.length,
          collisions,
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
