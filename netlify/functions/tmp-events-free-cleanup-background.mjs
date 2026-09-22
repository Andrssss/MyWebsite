// DISPOSABLE — 2026-09-22. One-time cleanup of the "job-events" blob after
// free/paid detection was added (see _ai_events_extract_core.mjs's `free`
// field, _events_jsonld_core.mjs's classifyFree, _job_events_store.mjs's
// free-filter in mergeAndPurgeEvents). Every event stored BEFORE this fix
// has no `free` field at all — this fetches each such event's OWN detail
// page and reclassifies it (cheap haiku single-field lookup via
// classifyEventPricing), then writes the full list back through
// mergeAndPurgeEvents so its existing free-filter drops the paid ones in
// one pass. Read-only against everything except the "job-events" blob
// itself. Delete after use.

import { withTimeout } from "./_error-logger.mjs";
import { getStore } from "@netlify/blobs";
import { readEvents, mergeAndPurgeEvents } from "./_job_events_store.mjs";
import { fetchListingPage, classifyEventPricing } from "./_ai_events_extract_core.mjs";

const TOKEN = "1da79ff50cbbe92c6d8045541555a734a2ecdeda29a7c330";
const CONCURRENCY = 5;

async function mapConcurrent(items, worker, limit) {
  const results = new Array(items.length);
  let i = 0;
  async function next() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await worker(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, next));
  return results;
}

const _runJob = withTimeout("tmp-events-free-cleanup-background", async () => {
  const resultStore = getStore("tmp-events-free-cleanup-result");
  const { events } = await readEvents();
  const toClassify = events.filter((e) => typeof e.free !== "boolean");
  const alreadyClassified = events.filter((e) => typeof e.free === "boolean");

  await resultStore.setJSON("latest.json", {
    startedAt: new Date().toISOString(),
    total: events.length,
    toClassify: toClassify.length,
    alreadyClassified: alreadyClassified.length,
    inProgress: true,
  });

  const reclassified = await mapConcurrent(
    toClassify,
    async (e) => {
      try {
        const html = await fetchListingPage(e.url);
        const { free } = await classifyEventPricing(html, { title: e.title });
        return { event: { ...e, free }, error: null };
      } catch (err) {
        // Can't confirm free — err on the side of dropping it (the board is
        // meant to be free-only; same "unknown = excluded" call as the
        // JSON-LD "no offers block" default in _events_jsonld_core.mjs).
        return { event: { ...e, free: false }, error: err.message };
      }
    },
    CONCURRENCY,
  );

  const dropped = reclassified
    .filter((r) => r.event.free === false)
    .map((r) => ({ url: r.event.url, title: r.event.title, source: r.event.source, fetchError: r.error }));
  const kept = reclassified
    .filter((r) => r.event.free !== false)
    .map((r) => ({ url: r.event.url, title: r.event.title, source: r.event.source }));

  const fullIncoming = [...alreadyClassified, ...reclassified.map((r) => r.event)];
  const { events: after } = await mergeAndPurgeEvents(fullIncoming);

  const out = {
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    totalBefore: events.length,
    reclassifiedCount: toClassify.length,
    droppedAsPaidCount: dropped.length,
    dropped,
    keptCount: kept.length,
    totalAfter: after.length,
    inProgress: false,
  };
  await resultStore.setJSON("latest.json", out);
  console.log(
    `[tmp-events-free-cleanup] totalBefore=${events.length} reclassified=${toClassify.length} droppedAsPaid=${dropped.length} totalAfter=${after.length}`,
  );
  return new Response("OK");
});

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });
  return _runJob(request);
};
