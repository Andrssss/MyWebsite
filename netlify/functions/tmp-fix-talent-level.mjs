// DISPOSABLE one-off correction endpoint — delete after use.
//
// Backfills job_posts rows that the "talent" keyword bug (fixed 2026-09-08 in
// _experience_core.mjs / src/lib/experienceLevel.mjs / JobWatcher.jsx)
// mislabeled: any title containing "talent" (e.g. "Talent Pool") got force-
// classified as an internship, even for clearly non-intern postings like
// "Specialist, Contingent Workforce (talent pool)" or "medior tester (talent
// pool)". Re-derives `experience`/`level` using the now-fixed logic, imported
// straight from the corrected source files so there is exactly one definition
// of "internship title" / "computed level" in play.
//
//   curl "https://bakan7.netlify.app/.netlify/functions/tmp-fix-talent-level?dryRun=1" \
//     -H "Authorization: Bearer d802889e1db90d39e3b1fe0395e3ffe5bc65b2de0002a7e9"
//
// Drop ?dryRun=1 to actually apply. DELETE THIS FILE once the fix has run.

import { Pool } from "pg";
import { withDbAuditFlush } from "./_db_audit.js";
import { isInternshipTitle, INTERN_SOURCES } from "./_experience_core.mjs";
import { computeLevel, isInternSource } from "../../src/lib/experienceLevel.mjs";

const TOKEN = "d802889e1db90d39e3b1fe0395e3ffe5bc65b2de0002a7e9";

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

function json(status, body) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

const hasTalentWord = (title) => /(^|[^a-z0-9])talent([^a-z0-9]|$)/i.test(String(title || ""));

export default withDbAuditFlush("tmp-fix-talent-level", async (request) => {
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (token !== TOKEN) return json(401, { error: "Unauthorized" });

  const url = new URL(request.url);
  const dryRun = url.searchParams.get("dryRun") === "1";

  let client;
  try {
    client = await pool.connect();
    const { rows } = await client.query(
      `SELECT id, title, source, experience, level FROM job_posts WHERE title ILIKE '%talent%'`
    );

    const changes = [];
    for (const row of rows) {
      if (!hasTalentWord(row.title)) continue;

      let experience = row.experience;
      const genuinelyIntern = isInternshipTitle(row.title) || INTERN_SOURCES.includes(row.source) || isInternSource(row.source);

      if (!genuinelyIntern && experience === "diákmunka") {
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
});
