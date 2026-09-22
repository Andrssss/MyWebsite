// DISPOSABLE — one-off verification, remove after use.
// Confirms _ats_tenants_core.mjs works correctly when imported fresh (Blob
// reads succeed, response shape is sane) without touching AI_MCP_TOKEN.
import { getAtsDiscoverySnapshot } from "./_ats_tenants_core.mjs";

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!process.env.TMP_READ_TOKEN || auth !== process.env.TMP_READ_TOKEN) {
    return new Response("Unauthorized", { status: 401 });
  }

  const snapshot = await getAtsDiscoverySnapshot();
  return new Response(
    JSON.stringify(
      {
        ok: true,
        suggestedQueries: snapshot.suggestedQueries,
        queryBankLength: snapshot.queryBank.length,
        hasWorkdayQuery: snapshot.queryBank.some((q) => q.includes("myworkdayjobs")),
        counts: snapshot.counts,
        tenantSample: snapshot.tenants.slice(0, 3),
        knownMissesCount: snapshot.knownMisses.length,
        probeableProviders: snapshot.probeableProviders,
        supportedProviders: snapshot.supportedProviders,
        instructionsStepsCount: snapshot.instructions.steps.length,
      },
      null,
      2
    ),
    { headers: { "Content-Type": "application/json; charset=utf-8" } }
  );
};
