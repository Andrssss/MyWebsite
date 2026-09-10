// DISPOSABLE revive endpoint — 2026-09-10, for GitHub issue #13. Delete after use.
// Flips active=true/sweep_dead=false for 3 rows independently verified live
// (WebFetch + raw curl, outside the scraper's own code) but stuck inactive:
//   - UniCredit Talent Community (ai-scraped): a sign-up page an earlier
//     ai-deactivate.mjs call misjudged as "closed" for lacking a role
//     description; ai-scraped is deliberately NOT in SWEEP_SOLE_DEACTIVATOR_SOURCES
//     (that endpoint also encodes real policy dedup, so it can't auto-revive).
//   - 2x Wise/SmartRecruiters (ats-crawl): the exact rows from issue #13,
//     already fixed at the root (46b1048/885eaf4) and would self-heal at the
//     next 14:00 UTC sweep anyway — reviving now just closes the loop early.
import { Pool } from "pg";

const TOKEN = "a0eb9f13a58899410d9ed181dc217ee031377cea39b1151c";
const connectionString = process.env.NETLIFY_DATABASE_URL;
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

const URLS = [
  "https://careers.unicredit.eu/hu_HU/jobsuche/TalentCommunity",
  "https://jobs.smartrecruiters.com/Wise/744000126301289-wise-platform-enterprise-specialist",
  "https://jobs.smartrecruiters.com/Wise/744000126049660-software-engineer-java-mitigation-requirements",
];

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });

  const client = await pool.connect();
  try {
    const { rows: before } = await client.query(
      `SELECT url, source, active, sweep_dead FROM job_posts WHERE url = ANY($1::text[])`,
      [URLS]
    );
    const { rows: updated } = await client.query(
      `UPDATE job_posts SET active = true, sweep_dead = false
        WHERE url = ANY($1::text[])
        RETURNING url, source, active, sweep_dead`,
      [URLS]
    );
    return new Response(JSON.stringify({ before, updated }, null, 2), {
      headers: { "content-type": "application/json" },
    });
  } finally {
    client.release();
  }
};
