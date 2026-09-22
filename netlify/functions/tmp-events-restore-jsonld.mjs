// DISPOSABLE — 2026-09-22. INCIDENT RECOVERY: tmp-events-free-cleanup-background
// wiped the "job-events" blob to 0 rows because ANTHROPIC_API_KEY turned out to
// be missing from the production environment, so every free/paid
// reclassification call failed and hit the "unknown -> exclude" default. This
// restores what CAN be recovered without the AI key: kibernaptar's jsonld
// source (deterministic, no LLM). The llm-read sources (the majority of the
// board) need ANTHROPIC_API_KEY restored, then a normal cron_job_events
// run (or a repeat of this recipe extended to those sources) to come back.
// Read-only against everything except the "job-events" blob. Delete after use.

import { withTimeout } from "./_error-logger.mjs";
import { fetchListingPage } from "./_ai_extract_core.mjs";
import { extractEventsJsonLd } from "./_events_jsonld_core.mjs";
import { mergeAndPurgeEvents } from "./_job_events_store.mjs";

const TOKEN = "1da79ff50cbbe92c6d8045541555a734a2ecdeda29a7c330";
const KIBERNAPTAR_URL = "https://kibernaptar.hu/esemenylista/";

const _runJob = withTimeout("tmp-events-restore-jsonld", async () => {
  const html = await fetchListingPage(KIBERNAPTAR_URL);
  const events = extractEventsJsonLd(html, { baseUrl: KIBERNAPTAR_URL }).map((e) => ({
    ...e,
    source: "kibernaptar",
  }));
  const { events: after } = await mergeAndPurgeEvents(events);
  return new Response(
    JSON.stringify({ restored: events.length, totalAfter: after.length }, null, 2),
    { headers: { "content-type": "application/json; charset=utf-8" } },
  );
});

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });
  return _runJob(request);
};
