// netlify/functions/ats-tenants.mjs
//
// REST transport for the search-based ATS discovery channel (WEB_CRAWLER_PLAN.md
// F2, §3.2a). The actual GET/POST logic is NOT duplicated here — both this file
// and ai-mcp.mjs's `get_ats_discovery` / `submit_ats_tenants` tools call into
// _ats_tenants_core.mjs, so there is exactly one implementation regardless of
// transport (same pattern as ai-registry.mjs / ai-mcp.mjs / _ai_registry_core.mjs).
//
// 2026-09-22: this endpoint went live 2026-08-26 but was never actually wired
// into the pestidev routine's prompt — see _ats_tenants_core.mjs's header for
// why the originally-planned curl+AI_INGEST_TOKEN promptSnippet would have hit
// the same auto-mode permission block that killed the registry's old REST
// fallback. The routine now reaches this via the MCP tools instead; this REST
// endpoint remains for manual/curl use (testing, one-off checks).
//
//   curl https://bakan7.netlify.app/.netlify/functions/ats-tenants \
//     -H "Authorization: Bearer $AI_INGEST_TOKEN"
//
//   curl -X POST https://bakan7.netlify.app/.netlify/functions/ats-tenants \
//     -H "Authorization: Bearer $AI_INGEST_TOKEN" -H "Content-Type: application/json" \
//     -d '{"urls":["https://jobs.ashbyhq.com/seon/abc"],"tenants":[{"provider":"lever","slug":"acme"}]}'

import { getAtsDiscoverySnapshot, submitAtsTenants } from "./_ats_tenants_core.mjs";

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, no-store" },
  });
}

function authorized(request) {
  const expected = process.env.AI_INGEST_TOKEN || process.env.CRON_SECRET;
  if (!expected) return false;
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  return token === expected;
}

// Ugyanaz a 401-diagnosztika, mint az ai-registry-ben: megmondja, MELYIK
// env-változóhoz hasonlítunk és jött-e egyáltalán bearer — a titokból semmit.
function authDiagnostic(request) {
  return {
    comparingAgainst: process.env.AI_INGEST_TOKEN ? "AI_INGEST_TOKEN"
      : process.env.CRON_SECRET ? "CRON_SECRET (fallback — AI_INGEST_TOKEN is NOT set)"
      : "nothing (neither AI_INGEST_TOKEN nor CRON_SECRET is set)",
    bearerReceived: /^Bearer\s+\S/i.test(request.headers.get("authorization") || ""),
  };
}

async function handleGet() {
  return json(200, await getAtsDiscoverySnapshot());
}

async function handlePost(request) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  try {
    return json(200, await submitAtsTenants(payload));
  } catch (err) {
    if (err.status) return json(err.status, { error: err.message, ...err.details });
    throw err;
  }
}

export default async (request) => {
  if (!authorized(request)) return json(401, { error: "Unauthorized", ...authDiagnostic(request) });

  if (request.method === "GET") return await handleGet();
  if (request.method === "POST") return await handlePost(request);
  return json(405, { error: "GET or POST only" });
};
