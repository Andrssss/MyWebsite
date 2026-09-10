// netlify/functions/migrate-permanently-rejected.mjs
//
// ONE-TIME migration: converts legacy free-text permanentlyRejected entries
// ("Company Name (domain.com) — reason") into structured
// {slug, domain, company, reason} records, matching the slug already used by
// `sites` wherever possible. See AI_SCRAPER_PERMANENTLY_REJECTED_PROPOSAL.md.
//
// Idempotent: if the first entry in permanentlyRejected is already an
// object, this is a no-op.
//
// DELETE THIS FILE after it has been run once successfully in production.
//
//   curl "https://bakan7.netlify.app/.netlify/functions/migrate-permanently-rejected?dryRun=1" \
//     -H "Authorization: Bearer $AI_INGEST_TOKEN"
//
//   curl -X POST "https://bakan7.netlify.app/.netlify/functions/migrate-permanently-rejected" \
//     -H "Authorization: Bearer $AI_INGEST_TOKEN"

import { getStore } from "@netlify/blobs";

const STORE_NAME = "ai-scraped-registry";
const KEY = "registry.json";

function json(status, body) {
  return new Response(JSON.stringify(body, null, 2), {
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

function toSlug(s) {
  return String(s || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

// Parses "Company Name (domain.com/path) — reason text" (em dash or hyphen).
// A string that doesn't match the pattern still becomes a record (domain:
// null) rather than being silently dropped.
function parseLegacyEntry(raw) {
  const s = String(raw || "").trim();
  const m = s.match(/^(.*?)\s*\(([^)]+)\)\s*[—-]\s*(.*)$/s);
  if (!m) return { company: s || null, domain: null, reason: null };
  const [, company, parenContent, reason] = m;
  const domain = parenContent.split("/")[0].trim().toLowerCase() || null;
  return { company: company.trim() || null, domain, reason: reason.trim() || null };
}

export default async (request) => {
  if (!authorized(request)) return json(401, { error: "Unauthorized" });
  if (request.method !== "GET" && request.method !== "POST") {
    return json(405, { error: "GET (dry run) or POST (write) only" });
  }

  const dryRun = request.method === "GET" || new URL(request.url).searchParams.has("dryRun");

  const store = getStore({ name: STORE_NAME, consistency: "strong" });
  const reg = await store.get(KEY, { type: "json" });
  if (!reg || typeof reg !== "object") return json(404, { error: "registry.json not found" });

  const legacy = Array.isArray(reg.permanentlyRejected) ? reg.permanentlyRejected : [];
  if (legacy.length === 0) return json(200, { ok: true, note: "permanentlyRejected is empty, nothing to migrate" });
  if (typeof legacy[0] === "object") {
    return json(200, { ok: true, note: "already migrated — first entry is already a structured record", sample: legacy[0] });
  }

  // domain -> slug, from the sites the registry already tracks. Preferred
  // slug source: it's the slug site-change-check/site-processor actually use.
  const domainToSlug = new Map();
  for (const [slug, site] of Object.entries(reg.sites || {})) {
    const h = hostnameOf(site?.url);
    if (h && !domainToSlug.has(h)) domainToSlug.set(h, slug);
  }

  const bySlug = new Map();
  const needsReview = [];

  for (const raw of legacy) {
    const { company, domain, reason } = parseLegacyEntry(raw);
    const matchedSlug = domain && domainToSlug.get(domain);
    const slug = matchedSlug || toSlug(company) || toSlug(domain) || toSlug(raw);

    if (!slug) {
      needsReview.push({ raw, issue: "could not derive a slug at all" });
      continue;
    }
    if (!matchedSlug) {
      needsReview.push({ raw, issue: "no matching site in `sites` — slug derived from company/domain text, unverified", derivedSlug: slug });
    }

    if (bySlug.has(slug)) {
      // Same slug hit twice under the old free-text scheme — keep the first
      // record, append the extra reason instead of silently dropping it.
      const existing = bySlug.get(slug);
      existing.reason = [existing.reason, reason].filter(Boolean).join("; ");
      continue;
    }
    bySlug.set(slug, { slug, domain, company, reason });
  }

  const migrated = [...bySlug.values()];

  const summary = {
    ok: true,
    dryRun,
    before: legacy.length,
    after: migrated.length,
    unmatchedToExistingSite: needsReview.filter((r) => r.issue.startsWith("no matching")).length,
    needsReview, // inspect before trusting a POST run if this is non-empty
  };

  if (dryRun) return json(200, { ...summary, preview: migrated.slice(0, 10) });

  await store.setJSON(KEY, { ...reg, permanentlyRejected: migrated, updatedAt: new Date().toISOString() });
  return json(200, summary);
};
