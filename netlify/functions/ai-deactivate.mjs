// netlify/functions/ai-deactivate.mjs
//
// Lets the AI discovery routine mark specific `AI-scraped` rows inactive
// (duplicate, closed, senior-level miss caught in a live check, etc.)
// WITHOUT ever holding a DB connection string. Same token as ai-ingest.mjs
// (AI_INGEST_TOKEN, falling back to CRON_SECRET) — the routine already has
// that, and it deliberately never gets NETLIFY_DATABASE_URL or ADMIN_SECRET
// (see AI_SCRAPER_PLAN.md / CLAUDE.md admin-credentials section).
//
// Scoped to source = 'AI-scraped' only, by design: the token this endpoint
// accepts is the low-privilege AI one, so even a leaked token (or a bug in
// the routine's own reasoning) can only ever deactivate rows the AI pipeline
// itself created — it has no reach into any other scraper's data.
//
//   curl -X POST https://bakan7.netlify.app/.netlify/functions/ai-deactivate \
//     -H "Authorization: Bearer $AI_INGEST_TOKEN" -H "Content-Type: application/json" \
//     -d '{"urls":["https://example.hu/allas/1"],"reason":"duplicate of JR024301, direct Workday listing"}'

import { Pool } from "pg";
import { ensureActiveSchema } from "./_active_core.mjs";
import { AI_SOURCE } from "./_ai_ingest_core.mjs";
import { MAX_ROWS_PER_REQUEST } from "./_ai_rate_limit.mjs";
import { withDbAuditFlush } from "./_db_audit.js";

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export default withDbAuditFlush("ai-deactivate", async (request) => {
  const expected = process.env.AI_INGEST_TOKEN || process.env.CRON_SECRET;
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!expected || token !== expected) {
    return json(401, { error: "Unauthorized" });
  }
  if (request.method !== "POST") return json(405, { error: "POST only" });

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  const urls = Array.isArray(payload.urls)
    ? [...new Set(payload.urls.filter((u) => typeof u === "string" && u.trim()).map((u) => u.trim()))]
    : [];
  if (urls.length === 0) return json(400, { error: "urls (nem üres tömb) kötelező." });
  if (urls.length > MAX_ROWS_PER_REQUEST) {
    return json(413, { error: "Too many urls in one request", max: MAX_ROWS_PER_REQUEST, received: urls.length });
  }
  const reason = typeof payload.reason === "string" ? payload.reason.slice(0, 300) : null;

  const client = await pool.connect();
  try {
    await ensureActiveSchema(client);
    const res = await client.query(
      `UPDATE job_posts
          SET active = false, sweep_dead = true
        WHERE source = $1
          AND url = ANY($2::text[])
          AND active = true
        RETURNING url`,
      [AI_SOURCE, urls]
    );
    const deactivated = res.rows.map((r) => r.url);
    const notFoundOrAlreadyInactive = urls.filter((u) => !deactivated.includes(u));
    console.log(
      `[ai-deactivate] deactivated=${deactivated.length} skipped=${notFoundOrAlreadyInactive.length}` +
        (reason ? ` reason=${reason}` : "")
    );
    return json(200, { deactivated, notFoundOrAlreadyInactive, reason });
  } catch (err) {
    console.error(`[ai-deactivate] error: ${err.message}`);
    return json(500, { error: "Szerver hiba", details: err.message });
  } finally {
    client.release();
  }
});
