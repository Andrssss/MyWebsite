// DISPOSABLE — 2026-09-23. One-time setup for the new `ical` event_sources
// mode: registers the 8 verified meetup.com groups, removes the now-
// redundant "hwsw" llm-read registration + the manually-inserted rows for
// the same real-world events under their non-meetup.com URLs (avoiding
// duplicate rows once the ical source re-adds them under the canonical
// meetup.com URL), then runs the ical extraction immediately instead of
// waiting for the next scheduled cron. Delete after use.

import { Pool } from "pg";
import { fetchListingPage } from "./_ai_extract_core.mjs";
import { extractEventsIcal } from "./_events_ical_core.mjs";
import { readEvents, mergeAndPurgeEvents } from "./_job_events_store.mjs";
import { getStore } from "@netlify/blobs";

const TOKEN = "1da79ff50cbbe92c6d8045541555a734a2ecdeda29a7c330";
const connectionString = process.env.NETLIFY_DATABASE_URL;
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

const NEW_ICAL_SOURCES = [
  { site: "devbp-meetup", slug: "devbp-meetup" },
  { site: "pyladies-budapest", slug: "pyladies-budapest" },
  { site: "taboola-budapest-tech-meetup", slug: "taboola-budapest-tech-meetup" },
  { site: "aws-serverless-budapest", slug: "aws-serverless-budapest" },
  { site: "teszt-tea", slug: "teszt-tea" },
  { site: "gloster-ai-klub", slug: "gloster-ai-klub" },
  { site: "hwswfree", slug: "hwswfree" },
  { site: "digitalk-tech-hungary", slug: "mndwrk-hungary" }, // real meetup.com slug differs from display name
];

// Rows manually inserted in earlier batches for events these new ical
// sources will now cover under their canonical meetup.com URL.
const SUPERSEDED_EVENT_URLS = new Set([
  "https://rendezveny.hwsw.hu/kraftie/12/ai-agent-technologiai-munkaeropiaci-hatasok-2026-informatika-munka-karrier-meetup",
  "https://www.eventbrite.com/e/beerup-ai-edition-tickets-1996973372113",
  "https://digitalk.tech/events/beerup-cybersecurity-edition",
]);

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });

  const client = await pool.connect();
  const registered = [];
  try {
    for (const s of NEW_ICAL_SOURCES) {
      const listUrl = `https://www.meetup.com/${s.slug}/events/ical/`;
      const { rows } = await client.query(
        `INSERT INTO event_sources (site, list_url, mode)
         VALUES ($1, $2, 'ical')
         ON CONFLICT (site) DO UPDATE SET list_url = EXCLUDED.list_url, mode = 'ical'
         RETURNING site, list_url, mode`,
        [s.site, listUrl],
      );
      registered.push(rows[0]);
    }
    await client.query(`DELETE FROM event_sources WHERE site = 'hwsw'`);
  } finally {
    client.release();
  }

  // Drop the superseded manual rows directly (mergeAndPurgeEvents only
  // upserts/filters, it never removes a row absent from `incoming`).
  const { events: current } = await readEvents();
  const kept = current.filter((e) => !SUPERSEDED_EVENT_URLS.has(e.url));
  const droppedCount = current.length - kept.length;
  const store = getStore({ name: "job-events", consistency: "strong" });
  await store.setJSON("latest.json", { generatedAt: new Date().toISOString(), events: kept });

  // Now populate the new sources immediately.
  const collected = [];
  const perSource = [];
  for (const s of registered) {
    try {
      const icalText = await fetchListingPage(s.list_url);
      const events = extractEventsIcal(icalText, { defaultLocation: "Budapest" }).map((e) => ({
        ...e,
        source: s.site,
      }));
      collected.push(...events);
      perSource.push({ site: s.site, count: events.length });
    } catch (err) {
      perSource.push({ site: s.site, error: err.message });
    }
  }
  const { events: after } = await mergeAndPurgeEvents(collected);

  return new Response(
    JSON.stringify({ registered, droppedSupersededCount: droppedCount, perSource, totalAfter: after.length }, null, 2),
    { headers: { "content-type": "application/json; charset=utf-8" } },
  );
};
