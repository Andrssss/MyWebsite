// DISPOSABLE — 2026-09-16 (issue #17 follow-up). One-time merge of ATS
// tenant rows that were split into two under one provider+company by
// slug-casing before tenantKey() started normalizing it (_ats_state.mjs).
// Read + merge + single write, no other endpoint calls. Delete after use.
import { readTenants, writeTenants, tenantKey } from "./_ats_state.mjs";

// Dedicated one-off env var — CRON_SECRET/AI_INGEST_TOKEN are Sensitive
// (write-only) in Netlify and can't be read back to invoke this.
const EXPECTED_TOKEN = process.env.TMP_ATS_DEDUPE_TOKEN;

function score(t) {
  // Prefer more crawl history, then a known company name, then more recent data.
  return (t.hitCount || 0) * 1000 + (t.company ? 1 : 0) * 10 + (t.lastHuCount || 0);
}

export default async (request) => {
  if (!EXPECTED_TOKEN) return new Response("missing TMP_ATS_DEDUPE_TOKEN", { status: 500 });
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${EXPECTED_TOKEN}`) return new Response("unauthorized", { status: 401 });

  const dryRun = new URL(request.url).searchParams.get("dryRun") !== "0";

  const tenants = await readTenants();
  const groups = new Map(); // normalized key -> [rawKey, tenant][]
  for (const [rawKey, t] of Object.entries(tenants)) {
    const norm = tenantKey(t.provider, t.slug);
    if (!groups.has(norm)) groups.set(norm, []);
    groups.get(norm).push([rawKey, t]);
  }

  const merges = [];
  for (const [norm, entries] of groups) {
    if (entries.length < 2) continue;
    entries.sort((a, b) => score(b[1]) - score(a[1]));
    const [keepKey, keep] = entries[0];
    const dropped = entries.slice(1);
    merges.push({
      normalizedKey: norm,
      kept: { rawKey: keepKey, provider: keep.provider, slug: keep.slug, company: keep.company, hitCount: keep.hitCount, lastHuCount: keep.lastHuCount },
      dropped: dropped.map(([k, t]) => ({ rawKey: k, provider: t.provider, slug: t.slug, company: t.company, hitCount: t.hitCount, lastHuCount: t.lastHuCount })),
    });
    if (!dryRun) {
      for (const [dropKey] of dropped) delete tenants[dropKey];
      if (keepKey !== norm) {
        tenants[norm] = keep;
        delete tenants[keepKey];
      }
    }
  }

  if (!dryRun && merges.length > 0) await writeTenants(tenants);

  return new Response(JSON.stringify({ dryRun, groupsWithDuplicates: merges.length, merges }, null, 2), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
};
