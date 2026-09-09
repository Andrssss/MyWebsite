// DISPOSABLE read-only audit endpoint — delete after use.
//
// The "talent" keyword bug (fixed 2026-09-08) showed two distinct failure
// modes in the intern/experience keyword lists:
//   1) SUBSTRING embedding: INTERN_KEYWORDS (experienceLevel.mjs/JobWatcher.jsx)
//      matches via plain `.includes()`, no word boundary — "intern" also
//      matches inside "Internet"/"International"/"internal".
//   2) SEMANTIC false positive: a real, whole, word-boundary-matched word
//      (like "talent") that just isn't a reliable level signal on its own.
// This scans real job_posts titles for every keyword in both keyword lists
// so both failure modes can be eyeballed with actual data instead of guessing.
//
//   curl "https://bakan7.netlify.app/.netlify/functions/tmp-audit-intern-keywords" \
//     -H "Authorization: Bearer 9f13c2a0e7b4418d9c6e2b1a7d5f0938ac41e9d0b2c5f781"

import { Pool } from "pg";

const TOKEN = "9f13c2a0e7b4418d9c6e2b1a7d5f0938ac41e9d0b2c5f781";

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

function json(status, body) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

// Mirrors _experience_core.mjs's hasKeyword (ASCII word boundary — good enough
// for spotting which titles DON'T have a clean boundary, i.e. the embedding case).
function isWholeWordMatch(title, kw) {
  const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(title);
}

// Every keyword currently used anywhere in the intern/junior/medior
// classification chain (read-side INTERN_KEYWORDS, write-side
// INTERNSHIP_KEYWORDS/JUNIOR_KEYWORDS/MID_KEYWORDS).
const KEYWORDS = [
  "intern", "gyakornok", "trainee", "diák", "diákmunka", "diakmunka",
  "internship", "pályakezdő", "palyakezdo", "tehetsegprogram", "tehetségprogram",
  "student", "students", "early career", "junior", "graduate",
  "medior", "mid-level", "mid level",
];

export default async (request) => {
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (token !== TOKEN) return json(401, { error: "Unauthorized" });

  const client = await pool.connect();
  try {
    const report = {};
    for (const kw of KEYWORDS) {
      const { rows } = await client.query(
        `SELECT DISTINCT title FROM job_posts WHERE title ILIKE $1 LIMIT 40`,
        [`%${kw}%`]
      );
      const embedded = rows.filter((r) => !isWholeWordMatch(r.title, kw));
      const wholeWord = rows.filter((r) => isWholeWordMatch(r.title, kw));
      report[kw] = {
        sampleCount: rows.length,
        embeddedNotWholeWord: embedded.map((r) => r.title),
        wholeWordSample: wholeWord.slice(0, 20).map((r) => r.title),
      };
    }
    return json(200, report);
  } finally {
    client.release();
  }
};
