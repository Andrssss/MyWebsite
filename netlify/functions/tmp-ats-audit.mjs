// DISPOSABLE — 2026-09-16. Read-only summary of the `ats-state` Blob
// (tenants.json + candidates.json) so we can look at real numbers before
// deciding what to improve on the ATS crawl/discover pipeline. No writes,
// no other endpoint calls, no other env vars needed — reads the Blob
// directly, same as _ats_state.mjs's own callers. Delete after use.
import { readTenants, readCandidateState, tenantKey } from "./_ats_state.mjs";

// Dedicated one-off env var (not AI_INGEST_TOKEN/CRON_SECRET) — those are
// Sensitive/write-only in Netlify and can't be read back to invoke this from
// outside the dashboard. TMP_ATS_AUDIT_TOKEN is set (non-sensitive, so it
// can be read back) just for this endpoint's lifetime and removed from
// Netlify along with this file once the numbers are pulled.
const EXPECTED_TOKEN = process.env.TMP_ATS_AUDIT_TOKEN;

const RECHECK_NO_HU_DAYS = 3;

function daysAgo(iso) {
  if (!iso) return null;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}

function topN(arr, n, key) {
  return [...arr].sort((a, b) => (b[key] || 0) - (a[key] || 0)).slice(0, n);
}

export default async (request) => {
  if (!EXPECTED_TOKEN) return new Response("missing AI_INGEST_TOKEN/CRON_SECRET", { status: 500 });
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${EXPECTED_TOKEN}`) return new Response("unauthorized", { status: 401 });

  const tenants = await readTenants();
  const { candidates, seenCompanies } = await readCandidateState();

  const tenantList = Object.values(tenants);
  const noHuCutoff = Date.now() - RECHECK_NO_HU_DAYS * 86400000;

  const byStatus = {};
  const byProvider = {};
  const byDiscoveredVia = {};
  let neverChecked = 0;
  let dueNoHu = 0;

  for (const t of tenantList) {
    byStatus[t.status] = (byStatus[t.status] || 0) + 1;
    byProvider[t.provider] = (byProvider[t.provider] || 0) + 1;
    const via = t.discoveredVia || "seed/manual";
    byDiscoveredVia[via] = (byDiscoveredVia[via] || 0) + 1;
    if (!t.lastChecked) neverChecked += 1;
    if (t.status === "no_hu" && t.lastChecked && new Date(t.lastChecked).getTime() < noHuCutoff) dueNoHu += 1;
  }

  const liveTenants = tenantList.filter((t) => t.status === "live");
  const topByHu = topN(liveTenants, 20, "lastHuCount").map((t) => ({
    key: tenantKey(t.provider, t.slug),
    company: t.company,
    provider: t.provider,
    lastHuCount: t.lastHuCount,
    hitCount: t.hitCount,
    lastCheckedDaysAgo: daysAgo(t.lastChecked),
    discoveredVia: t.discoveredVia,
  }));

  const candidateList = Object.values(candidates);
  const candByStatus = {};
  const hitByProvider = {};
  for (const c of candidateList) {
    candByStatus[c.status] = (candByStatus[c.status] || 0) + 1;
    if (c.status === "hit" && c.hitProvider) {
      hitByProvider[c.hitProvider] = (hitByProvider[c.hitProvider] || 0) + 1;
    }
  }

  const dueCandidates = candidateList.filter((c) => {
    if (c.status === "new") return true;
    if (c.status === "error") return true; // approximate: ignores retryErrorDays cutoff
    if (c.status === "miss") return true; // approximate: ignores probeableProviders coverage
    return false;
  }).length;

  const body = {
    generatedAt: new Date().toISOString(),
    tenants: {
      total: tenantList.length,
      byStatus,
      byProvider,
      byDiscoveredVia,
      neverChecked,
      dueNoHuRecheck: dueNoHu,
      topByHuCount: topByHu,
    },
    candidates: {
      total: candidateList.length,
      byStatus: candByStatus,
      hitByProvider,
      approxDueNow: dueCandidates,
      seenCompanies: Object.keys(seenCompanies).length,
    },
  };

  return new Response(JSON.stringify(body, null, 2), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
};
