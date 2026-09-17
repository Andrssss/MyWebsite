// DISPOSABLE — 2026-09-17. GH issue #24 follow-up to #18: cebd6b7 made the
// bank/1-company scrapers write a company literal at INSERT time, but rows
// inserted BEFORE that fix (and all otp rows, which #18's sweep missed —
// see src/lib/crossSourceDupe.mjs) still have company IS NULL/''. Those rows
// stay invisible to dupeKey (both the ingest-side cross-source guard and the
// admin board's "Átfedés" badge) until backfilled. One-shot, literals match
// each scraper's own COMPANY_NAME constant exactly. Delete after use.
import { Pool } from "pg";

const TOKEN = "6d00e8f9ae060a6abba416616cef94f9238a02998480534f";
const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

const BACKFILL = [
  ["mbh", "MBH Bank"],
  ["erste", "Erste Bank"],
  ["mfb", "MFB Bank"],
  ["raiffeisen", "Raiffeisen Bank"],
  ["unicredit", "UniCredit Bank"],
  ["kh", "K&H Bank"],
  ["cg-jobstream", "Capgemini"],
  ["otp", "OTP Bank"],
];

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });

  const dryRun = new URL(request.url).searchParams.get("dryRun") === "1";

  const client = await pool.connect();
  try {
    const results = [];
    for (const [source, company] of BACKFILL) {
      if (dryRun) {
        const { rows } = await client.query(
          `SELECT count(*) AS would_update FROM job_posts
            WHERE source = $1 AND (company IS NULL OR company = '')`,
          [source]
        );
        results.push({ source, company, would_update: Number(rows[0].would_update) });
      } else {
        const res = await client.query(
          `UPDATE job_posts SET company = $2
            WHERE source = $1 AND (company IS NULL OR company = '')`,
          [source, company]
        );
        results.push({ source, company, updated: res.rowCount });
      }
    }
    return new Response(JSON.stringify({ dryRun, results }, null, 2), {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  } finally {
    client.release();
  }
};
