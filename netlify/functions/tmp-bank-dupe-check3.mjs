// DISPOSABLE — 2026-09-16. Third pass for GH issue #18. The exact dupeKey()
// check (tmp-bank-dupe-check2.mjs) found 0 clusters, but a same-bank/likely-
// same-posting scan by hand on its "mentions a bank name" list found real
// near-misses the exact key misses (e.g. LinkedIn's title carries a "(Cisco)"
// suffix profession.hu's copy doesn't). This returns, side by side, every
// bank-source row plus every OTHER source's row whose company genuinely
// names that bank/Capgemini (word-boundary match, not the "GmbH contains
// mbh" substring bug from the previous pass), so the actual title wording
// can be eyeballed pair by pair. Read-only. Delete after use.
import { Pool } from "pg";

const TOKEN = "c74259b35fe934e06817a7a0b86c80040c208737eea17950";
const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

const BANKS = [
  { source: "mbh", pattern: "\\ymbh\\y" },
  { source: "erste", pattern: "\\yerste\\y" },
  { source: "mfb", pattern: "\\ymfb\\y" },
  { source: "raiffeisen", pattern: "\\yraiffeisen\\y" },
  { source: "unicredit", pattern: "\\yunicredit\\y" },
  { source: "kh", pattern: "k\\s?&\\s?h" },
  { source: "cg-jobstream", pattern: "\\ycapgemini\\y" },
];
const BANK_SOURCES = BANKS.map((b) => b.source);

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });

  const client = await pool.connect();
  try {
    const out = {};
    for (const { source, pattern } of BANKS) {
      const own = await client.query(
        `SELECT id, title, url, active, company FROM job_posts WHERE source = $1 ORDER BY title`,
        [source]
      );
      const others = await client.query(
        `SELECT id, source, company, title, url, active
           FROM job_posts
          WHERE source <> ALL($2::text[])
            AND (company ~* $1 OR title ~* $1)
          ORDER BY title`,
        [pattern, BANK_SOURCES]
      );
      out[source] = { own: own.rows, others: others.rows };
    }

    return new Response(JSON.stringify(out, null, 2), {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  } finally {
    client.release();
  }
};
