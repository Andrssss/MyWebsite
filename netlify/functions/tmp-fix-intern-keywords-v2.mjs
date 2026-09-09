// DISPOSABLE one-off correction endpoint — delete after use.
//
// Backfills job_posts rows affected by the 2026-09-09 intern/junior keyword
// audit (see commit "Audit and fix false-positive-prone words across the
// intern/junior keyword lists"): the read-side INTERN_KEYWORDS substring bug
// ("intern" matching inside "internal"/"international") and the write-side
// "pályakezdő"/"early career" semantic false positives, wherever the TITLE
// ALONE is enough to explain the old wrong classification (descriptions
// aren't stored in job_posts, so title-only cases are the only ones we can
// safely re-derive after the fact).
//
//   curl "https://bakan7.netlify.app/.netlify/functions/tmp-fix-intern-keywords-v2?dryRun=1" \
//     -H "Authorization: Bearer 3a7c910de6b2489fa1d8e6c3b09f4a72d1e58c6b0f9a4732"

import { Pool } from "pg";
import { isInternshipTitle, INTERN_SOURCES } from "./_experience_core.mjs";
import { computeLevel, isInternSource } from "../../src/lib/experienceLevel.mjs";

const TOKEN = "3a7c910de6b2489fa1d8e6c3b09f4a72d1e58c6b0f9a4732";

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

function json(status, body) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function normalizeText(s) {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// The most permissive possible pre-fix shape: plain substring (no word
// boundary — matches the T/MIX/WORKCENTER bug) over the OLD keyword list
// (includes "pályakezdő"/"palyakezdo"/"early career", pre-2026-09-09).
// Deliberately a superset of every old code path so nothing that could have
// caused the old classification is missed.
const OLD_KEYWORDS_SUBSTRING = [
  "gyakornok", "intern", "internship", "trainee",
  "palyakezdo", "diakmunka",
  "tehetsegprogram", "student", "students", "early career",
];
const oldTitleMatch = (title) => {
  const t = normalizeText(title);
  return OLD_KEYWORDS_SUBSTRING.some((k) => t.includes(k));
};

export default async (request) => {
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (token !== TOKEN) return json(401, { error: "Unauthorized" });

  const url = new URL(request.url);
  const dryRun = url.searchParams.get("dryRun") === "1";

  let client;
  try {
    client = await pool.connect();
    const { rows } = await client.query(
      `SELECT id, title, source, experience, level FROM job_posts WHERE level = 'intern' OR experience = 'diákmunka'`
    );

    const changes = [];
    for (const row of rows) {
      let experience = row.experience;
      const sourceIsInternOnly = INTERN_SOURCES.includes(row.source) || isInternSource(row.source);

      if (
        !sourceIsInternOnly &&
        experience === "diákmunka" &&
        oldTitleMatch(row.title) &&
        !isInternshipTitle(row.title)
      ) {
        experience = "-";
      }

      const newLevel = computeLevel({ title: row.title, experience, source: row.source });

      if (experience !== row.experience || newLevel !== row.level) {
        changes.push({
          id: row.id,
          title: row.title,
          source: row.source,
          before: { experience: row.experience, level: row.level },
          after: { experience, level: newLevel },
        });
        if (!dryRun) {
          await client.query(`UPDATE job_posts SET experience = $1, level = $2 WHERE id = $3`, [
            experience,
            newLevel,
            row.id,
          ]);
        }
      }
    }

    return json(200, { dryRun, scanned: rows.length, changed: changes.length, changes });
  } catch (err) {
    return json(500, { error: err.message, stack: String(err.stack || "").slice(0, 2000) });
  } finally {
    if (client) client.release();
  }
};
