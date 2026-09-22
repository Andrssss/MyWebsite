// DISPOSABLE — one-off read, remove after use. See deploy-and-oneoff-writes-workflow.
// Returns the biggest (by job_posts posting count) companies whose slug-guess
// candidates were tried against ALL 7 probeable ATS providers and missed on
// every one — the pool worth testing with a raw-HTML ATS-signature grep.
import { Pool } from "pg";
import { readCandidateState } from "./_ats_state.mjs";
import { PROBEABLE_PROVIDERS } from "./_ats_slug_core.mjs";

const pool = new Pool({ connectionString: process.env.NETLIFY_DATABASE_URL, ssl: { rejectUnauthorized: false } });

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!process.env.TMP_READ_TOKEN || auth !== process.env.TMP_READ_TOKEN) {
    return new Response("Unauthorized", { status: 401 });
  }

  const state = await readCandidateState();
  const exhausted = new Map();
  for (const c of Object.values(state.candidates)) {
    if (c.status !== "miss") continue;
    const tried = new Set(c.probedProviders || []);
    if (!PROBEABLE_PROVIDERS.every((p) => tried.has(p))) continue;
    const company = c.sourceCompany;
    if (!company) continue;
    if (!exhausted.has(company)) exhausted.set(company, []);
    exhausted.get(company).push(c.slug);
  }

  const companyNames = [...exhausted.keys()];
  let counts = [];
  if (companyNames.length > 0) {
    const client = await pool.connect();
    try {
      const { rows } = await client.query(
        `SELECT company, COUNT(*) AS n FROM job_posts WHERE company = ANY($1::text[]) GROUP BY company ORDER BY n DESC LIMIT 40`,
        [companyNames]
      );
      counts = rows;
    } finally {
      client.release();
    }
  }

  return new Response(
    JSON.stringify(
      {
        totalExhaustedCandidateCompanies: companyNames.length,
        topByPostingCount: counts.map((r) => ({
          company: r.company,
          postings: Number(r.n),
          slugsTried: exhausted.get(r.company),
        })),
      },
      null,
      2
    ),
    { headers: { "Content-Type": "application/json; charset=utf-8" } }
  );
};
