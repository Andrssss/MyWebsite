// netlify/functions/ai-registry.mjs
//
// The REST transport for the AI-scraped discovery ROUTINE's memory/write API.
// The actual GET/POST logic lives in _ai_registry_core.mjs (getRegistrySnapshot
// / submitFindings) so it has one implementation shared with ai-mcp.mjs, the
// MCP transport for the same two operations — this file now only does
// Authorization-header auth and REST status-code/JSON shaping.
//
//   GET  → the routine's MEMORY. Routines start cold every run
//          (persist_session:false), so without this it would re-research the
//          same ~120 already-rejected companies forever. Returns the sites it
//          has checked (with lastChecked, for the 7-day re-check rule), the
//          permanently-rejected list, and the urls it has already found.
//
//   POST → the routine's WRITE. Findings go through the exact same
//          filter/upsert/reconcile tail every other AI-scraped write path uses
//          (_ai_ingest_core.mjs ingestJobs) — so the routine's own LLM judgment
//          is never the only gate; isItJob / isSeniorLike (title denylist) and
//          the company blocklist all re-apply here, deterministically, in code.
//
// The POST is INCREMENTAL, not a whole-state replace: the routine reports only
// what it did this run ({findings, sitesChecked, rejected}) and the server
// merges into stored state.
//
// State lives in Netlify Blobs (same store pattern as recovery-logs /
// weekly-backups) rather than Postgres — it's one small JSON doc of bookkeeping,
// not relational data, and this avoids a schema migration for it.
//
//   curl https://bakan7.netlify.app/.netlify/functions/ai-registry \
//     -H "Authorization: Bearer $AI_INGEST_TOKEN"
//
//   curl -X POST https://bakan7.netlify.app/.netlify/functions/ai-registry \
//     -H "Authorization: Bearer $AI_INGEST_TOKEN" -H "Content-Type: application/json" \
//     -d '{"findings":[{"slug":"example","title":"Junior Dev","url":"https://example.hu/allas/1",
//          "company":"ACME","experience":"junior","technologies":"Java"}],
//          "sitesChecked":{"example":{"url":"https://example.hu/karrier","status":"has_junior_opening"}},
//          "rejected":["SomeCorp"]}'
//
// See ai-mcp.mjs for the MCP transport of the same two operations — added so
// the routine's orchestrator can fetch/submit without ever composing a raw
// `curl -H "Authorization: Bearer $TOKEN"` command itself.

import { withDbAuditFlush } from "./_db_audit.js";
import { getRegistrySnapshot, submitFindings, RegistryRequestError } from "./_ai_registry_core.mjs";
import { tooManyRequests } from "./_ai_rate_limit.mjs";

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

// Accepts a token dedicated to this endpoint, falling back to CRON_SECRET so
// the function still works before AI_INGEST_TOKEN is set. AI_INGEST_TOKEN is
// the one to actually use: it has to live in the routine's stored prompt text
// (routines have no env-var injection), and a token that can only reach this
// one filtered endpoint is a far smaller blast radius than CRON_SECRET, which
// authorizes every background worker in the cron fleet.
function authorized(request) {
  const expected = process.env.AI_INGEST_TOKEN || process.env.CRON_SECRET;
  if (!expected) return false;
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  return token === expected;
}

// Deploy-time diagnostic for the 401 body. Reports only WHICH env var the
// function is comparing against and whether a token was sent at all — never any
// part of either secret. Without this, "var not set", "var has a typo", and
// "var set but Netlify hasn't redeployed yet" are indistinguishable from
// outside, since all three return an identical 401.
function authDiagnostic(request) {
  return {
    comparingAgainst: process.env.AI_INGEST_TOKEN ? "AI_INGEST_TOKEN"
      : process.env.CRON_SECRET ? "CRON_SECRET (fallback — AI_INGEST_TOKEN is NOT set)"
      : "nothing (neither AI_INGEST_TOKEN nor CRON_SECRET is set)",
    bearerReceived: /^Bearer\s+\S/i.test(request.headers.get("authorization") || ""),
  };
}

async function handleGet() {
  return json(200, await getRegistrySnapshot());
}

async function handlePost(request) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  try {
    return json(200, await submitFindings(payload));
  } catch (err) {
    if (err instanceof RegistryRequestError) {
      if (err.code === "too_many_rows") return json(413, { error: err.message, ...err.details });
      if (err.code === "rate_limited") return tooManyRequests({ limit: err.details.limit, resetInSeconds: err.details.retryAfterSeconds });
    }
    throw err;
  }
}

export default withDbAuditFlush("ai-registry", async (request) => {
  if (!authorized(request)) return json(401, { error: "Unauthorized", ...authDiagnostic(request) });
  if (request.method === "GET") return handleGet();
  if (request.method === "POST") return handlePost(request);
  return json(405, { error: "GET or POST only" });
});
