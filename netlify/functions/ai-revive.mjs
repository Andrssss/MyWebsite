// netlify/functions/ai-revive.mjs
//
// REST transport for the AI reactivation check (_ai_revive_core.mjs) — same
// role as ai-registry.mjs/ai-deactivate.mjs: the routine never gets a DB
// credential, only this scoped API. Same AI_INGEST_TOKEN (falling back to
// CRON_SECRET) as ai-ingest.mjs/ai-registry.mjs/ai-deactivate.mjs — this is
// the "AI family" token, deliberately never ADMIN_SECRET or the DB string.
//
// GET  -> candidate rows to review (sweep-killed, not yet AI-reviewed).
// POST -> this run's verdicts: {"alive":["url",...], "stillDead":["url",...]}.
//
// A Claude Routine should prefer the ai-mcp.mjs MCP tools (list_revive_candidates
// / submit_revive_verdicts) over composing curl calls here directly — see
// ai-mcp.mjs's header for why a Bash `curl -H "Authorization: Bearer $TOKEN"`
// call has repeatedly been refused by Claude Code's own permission classifier.
// This REST endpoint exists for manual/curl testing and as the documented
// fallback path (same pattern as the AI discovery routine's own MCP-first,
// curl-fallback transport choice).
//
//   curl https://bakan7.netlify.app/.netlify/functions/ai-revive \
//     -H "Authorization: Bearer $AI_INGEST_TOKEN"
//
//   curl -X POST https://bakan7.netlify.app/.netlify/functions/ai-revive \
//     -H "Authorization: Bearer $AI_INGEST_TOKEN" -H "Content-Type: application/json" \
//     -d '{"alive":["https://example.hu/allas/1"],"stillDead":["https://example.hu/allas/2"]}'

import { listReviveCandidates, applyReviveVerdicts, ReviveRequestError } from "./_ai_revive_core.mjs";
import { withDbAuditFlush } from "./_db_audit.js";

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function authorized(request) {
  const expected = process.env.AI_INGEST_TOKEN || process.env.CRON_SECRET;
  if (!expected) return false;
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  return token === expected;
}

export default withDbAuditFlush("ai-revive", async (request) => {
  if (!authorized(request)) return json(401, { error: "Unauthorized" });

  if (request.method === "GET") {
    const url = new URL(request.url);
    const limit = url.searchParams.get("limit");
    const { candidates, sources } = await listReviveCandidates({ limit });
    return json(200, { candidates, sources, count: candidates.length });
  }

  if (request.method === "POST") {
    let payload;
    try {
      payload = await request.json();
    } catch {
      return json(400, { error: "Invalid JSON body" });
    }
    try {
      const result = await applyReviveVerdicts(payload || {});
      console.log(
        `[ai-revive] reactivated=${result.reactivated.length} confirmedDead=${result.confirmedDead.length}`
      );
      return json(200, result);
    } catch (err) {
      if (err instanceof ReviveRequestError) {
        const status = err.code === "too_many_rows" ? 413 : 400;
        return json(status, { error: err.message, ...err.details });
      }
      console.error(`[ai-revive] error: ${err.message}`);
      return json(500, { error: "Szerver hiba", details: err.message });
    }
  }

  return json(405, { error: "GET or POST only" });
});
