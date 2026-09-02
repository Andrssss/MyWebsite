// Disposable, read-only verification (2026-09-02): does the merged
// smartrecruiters/wise + smartrecruiters/rolandberger tenant path work
// end-to-end through the SAME adapters ats-crawl uses, post-merge?
// No DB writes. Delete after use.

import { getProvider, deriveScopePrefix } from "./_ats_providers.mjs";
import { rejectAtsLocation } from "./_ats_location.mjs";

const TOKEN = "1b582e0fcb46139c8af2f7479eb376318d979f478b472934";

async function probe(slug) {
  const provider = getProvider("smartrecruiters");
  const listing = await provider.list(slug);
  const boardJobs = listing.jobs || [];
  const huJobs = boardJobs.filter((j) => !rejectAtsLocation(j.location));

  // SmartRecruiters list items carry no public url yet (only detailRef) --
  // fetch ONE detail so we can prove the real posting url + scope-prefix
  // derivation both still work, same as crawlTenant() does before insert.
  let sampleUrl = null;
  let detailError = null;
  if (huJobs[0]?.detailRef) {
    try {
      const detail = await provider.detail(huJobs[0]);
      sampleUrl = typeof detail === "object" ? detail.url : null;
    } catch (err) {
      detailError = err.message;
    }
  }

  const scopePrefix = sampleUrl ? deriveScopePrefix(slug, [sampleUrl]) : null;

  return {
    slug,
    notFound: listing.notFound,
    boardCount: boardJobs.length,
    huCount: huJobs.length,
    huTitles: huJobs.slice(0, 5).map((j) => j.title),
    sampleUrl,
    detailError,
    scopePrefix,
  };
}

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (token !== TOKEN) return new Response("Unauthorized", { status: 401 });

  try {
    const [wise, roland] = await Promise.all([probe("wise"), probe("rolandberger")]);
    return new Response(JSON.stringify({ wise, roland }, null, 2), {
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message, stack: err.stack }, null, 2), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
};
