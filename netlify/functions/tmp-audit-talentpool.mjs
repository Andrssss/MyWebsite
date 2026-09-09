// DISPOSABLE read-only audit endpoint — delete after use.
//
// Issue #10: "Talent Pool" category's keyword list doesn't catch
// "Italian Speaking Future Opportunities"-style postings (language-agnostic
// BPO collector ads — Concentrix, Teleperformance, Foundever, etc).
// Talent Pool is RULE 0 in categorize() — any match short-circuits every
// other rule (Security, DevOps, ...), so a bad keyword here has the largest
// possible blast radius of any category in the table. This audits the LIVE
// keyword list (not the test fixture) plus the issue's proposed addition
// (`~future opportunit`) against real job_posts titles, using the actual
// categorize() implementation so both "does it catch the gap" and "does it
// steal anything it shouldn't" are checked with real data, not guesses.
//
//   curl "https://bakan7.netlify.app/.netlify/functions/tmp-audit-talentpool" \
//     -H "Authorization: Bearer 7b8b966ca517d12d9b4fb329d9c893f299a3216faa9d7664"

import { Pool } from "pg";
import { categorize, TALENT_POOL } from "../../src/lib/categorize.mjs";

const TOKEN = "7b8b966ca517d12d9b4fb329d9c893f299a3216faa9d7664";

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

function json(status, body) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

// Candidate additions worth checking alongside the issue's own suggestion —
// other generic, language-agnostic "always hiring" collector phrasings that
// show up in the same BPO-ad family.
const CANDIDATES = [
  "~future opportunit",
  "~talent community",
  "~general application",
  "~open application",
  "~spontaneous application",
  "~future talent",
];

export default async (request) => {
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (token !== TOKEN) return json(401, { error: "Unauthorized" });

  const client = await pool.connect();
  try {
    const { rows: catRows } = await client.query(
      `SELECT id, name, keywords FROM job_categories ORDER BY id`
    );
    const liveCategories = catRows.map((r) => [r.name, r.keywords || []]);
    const talentPoolRow = catRows.find((r) => r.name === TALENT_POOL);

    // 1) Every keyword currently live on Talent Pool — sample what it
    // actually matches in production titles, using the real categorize()
    // so we see the FINAL category, not just a raw substring hit (a keyword
    // could match but lose to nothing, since rule 0 always wins — so any
    // match here IS the outcome).
    const perKeyword = {};
    for (const kwRaw of talentPoolRow?.keywords || []) {
      const kw = String(kwRaw);
      const bare = kw.startsWith("~") ? kw.slice(1) : kw;
      const { rows } = await client.query(
        `SELECT DISTINCT title FROM job_posts WHERE title ILIKE $1 LIMIT 60`,
        [`%${bare}%`]
      );
      perKeyword[kw] = {
        rawSubstringMatchCount: rows.length,
        samples: rows.map((r) => r.title),
      };
    }

    // 2) Candidate additions: for each, build a modified category list with
    // it appended to Talent Pool, then run EVERY sampled title (from a broad
    // net search) through both the live categorize() and the modified one,
    // reporting only titles whose classification CHANGES. Two outcomes to
    // eyeball per candidate: gains (good — the gap the issue describes) and
    // steals (bad — a title that already had a specific category, like
    // Security/DevOps, getting overridden to Talent Pool).
    const { rows: broadRows } = await client.query(
      `SELECT DISTINCT title FROM job_posts
       WHERE title ILIKE '%opportunit%' OR title ILIKE '%talent%'
          OR title ILIKE '%speaking%' OR title ILIKE '%general application%'
          OR title ILIKE '%open application%' OR title ILIKE '%spontaneous%'
       LIMIT 500`
    );
    const broadTitles = broadRows.map((r) => r.title);

    const candidateReport = {};
    for (const cand of CANDIDATES) {
      const modified = liveCategories.map(([name, kws]) =>
        name === TALENT_POOL ? [name, [...kws, cand]] : [name, kws]
      );
      const gains = [];
      const steals = [];
      for (const title of broadTitles) {
        const before = categorize(title, liveCategories);
        const after = categorize(title, modified);
        if (before === after) continue;
        if (after === TALENT_POOL && before === "Egyéb") gains.push({ title, before });
        else if (after === TALENT_POOL) steals.push({ title, before });
      }
      candidateReport[cand] = {
        gainsCount: gains.length,
        gains: gains.slice(0, 40),
        stealsCount: steals.length,
        steals: steals.slice(0, 40),
      };
    }

    // 3) The issue's specific example pattern, still uncategorized today?
    const { rows: stillMissedRows } = await client.query(
      `SELECT DISTINCT title FROM job_posts
       WHERE title ILIKE '%speaking%future%opportunit%'
          OR title ILIKE '%speaking%opportunit%'
       LIMIT 60`
    );
    const stillMissed = stillMissedRows.map((r) => ({
      title: r.title,
      currentCategory: categorize(r.title, liveCategories),
    }));

    // 4) Broader sanity pass: every `~` stem keyword in the whole table
    // (not just Talent Pool) with its live match count, so an obviously
    // runaway one (a short/common stem) stands out by volume alone.
    const allStemKeywords = {};
    for (const [name, kws] of liveCategories) {
      const stems = (kws || []).filter((k) => String(k).startsWith("~"));
      if (stems.length === 0) continue;
      allStemKeywords[name] = [];
      for (const kw of stems) {
        const bare = String(kw).slice(1);
        const { rows } = await client.query(
          `SELECT COUNT(DISTINCT title)::int AS c FROM job_posts WHERE title ILIKE $1`,
          [`%${bare}%`]
        );
        allStemKeywords[name].push({ keyword: kw, matchCount: rows[0].c });
      }
    }

    return json(200, {
      talentPoolRow: { id: talentPoolRow?.id, keywords: talentPoolRow?.keywords },
      perExistingKeyword: perKeyword,
      candidateAdditions: candidateReport,
      stillMissedToday: stillMissed,
      allStemKeywordVolumes: allStemKeywords,
    });
  } finally {
    client.release();
  }
};
