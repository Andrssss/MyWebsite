// TEMP one-off — collapse the 10 leftover `ai:<slug>`-style legacy sources
// (a different, older naming scheme than "AI - <slug>", never caught by the
// earlier migration/cleanup) into the current "AI-scraped" bucket. Same safe
// 3-step approach as the old migrateLegacyAiSources: dedupe among legacy rows
// sharing a url, drop legacy rows already covered by an AI-scraped row with
// the same url, then rename the survivors. Data-only fix, no app-code change.
// Disposable — delete after use.
import pkg from "pg";
const { Pool } = pkg;

const connectionString = process.env.NETLIFY_DATABASE_URL;
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });
const TOKEN = "c9e1a5d73f0b8624ae8d1c9b6e4a72f0813c6b9e2a5d7";

function json(status, body) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export default async (request) => {
  const url = new URL(request.url);
  if (url.searchParams.get("token") !== TOKEN) return json(401, { error: "Unauthorized" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const dedupe = await client.query(
      `DELETE FROM job_posts a USING job_posts b
        WHERE a.source LIKE 'ai:%' AND b.source LIKE 'ai:%'
          AND a.url = b.url AND a.id > b.id`
    );
    const droppedCovered = await client.query(
      `DELETE FROM job_posts j
        WHERE j.source LIKE 'ai:%'
          AND EXISTS (SELECT 1 FROM job_posts k WHERE k.url = j.url AND k.source = 'AI-scraped')`
    );
    const renamed = await client.query(
      `UPDATE job_posts SET source = 'AI-scraped' WHERE source LIKE 'ai:%'`
    );

    await client.query("COMMIT");
    return json(200, {
      dedupedAmongLegacy: dedupe.rowCount,
      droppedAlreadyCovered: droppedCovered.rowCount,
      renamedToAiScraped: renamed.rowCount,
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    return json(500, { error: err.message });
  } finally {
    client.release();
  }
};
