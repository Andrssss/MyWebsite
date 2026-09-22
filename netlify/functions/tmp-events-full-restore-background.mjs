// DISPOSABLE — 2026-09-22. INCIDENT RECOVERY, part 2. tmp-events-free-cleanup-
// background wiped the "job-events" blob to 0 rows because ANTHROPIC_API_KEY
// was missing from the Netlify production environment (every classifyEventPricing
// call failed and hit the unknown-so-exclude default). tmp-events-restore-jsonld
// already recovered the 6 kibernaptar rows that don't need the AI key. This
// recovers the REST: mirrors cron_job_events-background.mjs's per-source loop
// (every event_sources row, jsonld + llm-read) so all sources come back in one
// manual pass instead of waiting for the next scheduled run.
//
// DO NOT RUN THIS until ANTHROPIC_API_KEY is confirmed set again in the
// Netlify production environment — run it too early and every llm-read
// source just fails the same way the cleanup did. Failure here is harmless
// either way (a failed source contributes nothing to the merge, existing
// rows are untouched) but you won't get your events back until the key
// actually works.
//
// Deliberately skips the registrationDeadline detail-page follow-up (enrichDeadline
// in the real cron) to keep this simple and fast — the next real scheduled run
// (every 2 days, 05:30 UTC on odd calendar days) picks that up on its own via
// the normal deadlineChecked bookkeeping, no action needed here for that.
// Delete after use (this file + its -result.mjs companion).

import { Pool } from "pg";
import { withTimeout } from "./_error-logger.mjs";
import { getStore } from "@netlify/blobs";
import { extractEventsLLM, fetchListingPage } from "./_ai_events_extract_core.mjs";
import { extractEventsJsonLd } from "./_events_jsonld_core.mjs";
import { mergeAndPurgeEvents } from "./_job_events_store.mjs";

const TOKEN = "1da79ff50cbbe92c6d8045541555a734a2ecdeda29a7c330";

const connectionString = process.env.NETLIFY_DATABASE_URL;
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

async function runSite(site) {
  let html;
  try {
    html = await fetchListingPage(site.list_url);
  } catch (err) {
    return { site: site.site, ok: false, stage: "fetch", error: err.message, count: 0, events: [] };
  }
  try {
    if (site.mode === "jsonld") {
      const events = extractEventsJsonLd(html, { baseUrl: site.list_url }).map((e) => ({ ...e, source: site.site }));
      return { site: site.site, ok: true, count: events.length, events };
    }
    const { events } = await extractEventsLLM(html, { baseUrl: site.list_url });
    return {
      site: site.site,
      ok: true,
      count: events.length,
      events: events.map((e) => ({ ...e, source: site.site })),
    };
  } catch (err) {
    return { site: site.site, ok: false, stage: "extract", error: err.message, count: 0, events: [] };
  }
}

const _runJob = withTimeout("tmp-events-full-restore-background", async () => {
  const resultStore = getStore("tmp-events-full-restore-result");
  const client = await pool.connect();
  let sites;
  try {
    ({ rows: sites } = await client.query(
      `SELECT site, list_url, mode FROM event_sources WHERE mode <> 'disabled' ORDER BY site`,
    ));
  } finally {
    client.release();
  }

  await resultStore.setJSON("latest.json", {
    startedAt: new Date().toISOString(),
    sitesTotal: sites.length,
    inProgress: true,
  });

  const results = [];
  for (const site of sites) {
    results.push(await runSite(site));
  }

  const collected = results.flatMap((r) => r.events);
  const { events: after } = await mergeAndPurgeEvents(collected);

  const out = {
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    sitesChecked: sites.length,
    collected: collected.length,
    perSite: results.map((r) => ({ site: r.site, ok: r.ok, count: r.count, error: r.error || null })),
    failedSites: results.filter((r) => !r.ok).map((r) => ({ site: r.site, stage: r.stage, error: r.error })),
    totalAfter: after.length,
    inProgress: false,
  };
  await resultStore.setJSON("latest.json", out);
  console.log(
    `[tmp-events-full-restore] sites=${sites.length} collected=${collected.length} failed=${out.failedSites.length} totalAfter=${after.length}`,
  );
  return new Response("OK");
});

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });
  return _runJob(request);
};
