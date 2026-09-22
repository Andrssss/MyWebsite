// DISPOSABLE — 2026-09-22. Manual insert for events found via a live
// WebSearch/WebFetch pass (dev/tester/AI-focused, free-only, per user
// request) — mirrors what mergeAndPurgeEvents would do with a real
// extraction, just hand-built since ANTHROPIC_API_KEY is still missing so
// the llm-read pipeline can't run itself yet. Also registers new
// event_sources rows the same way tmp-events-register-source.mjs did
// (direct DB — event-sources.js's HTTP token still doesn't match the live
// value). Delete after use.

import { Pool } from "pg";
import { mergeAndPurgeEvents } from "./_job_events_store.mjs";

const TOKEN = "1da79ff50cbbe92c6d8045541555a734a2ecdeda29a7c330";
const connectionString = process.env.NETLIFY_DATABASE_URL;
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

const NEW_SOURCES = [{ site: "hwsw", list_url: "https://rendezveny.hwsw.hu/", mode: "llm-read" }];

const NEW_EVENTS = [
  {
    url: "https://rendezveny.hwsw.hu/kraftie/12/ai-agent-technologiai-munkaeropiaci-hatasok-2026-informatika-munka-karrier-meetup",
    title:
      "Tervezd újra a karriered az agentek világában – AI munkaerőpiaci és technológiai hatásai az informatikában (2026)",
    date: "2026-10-21",
    endDate: null,
    time: "17:00",
    endTime: "19:00",
    location: "Budapest (helyszín később) + Online",
    company: "HWSW",
    type: "eloadas",
    format: "hybrid",
    language: "hu",
    free: true,
    registrationDeadline: "2026-10-16",
    deadlineChecked: true,
    source: "hwsw",
  },
];

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });

  const client = await pool.connect();
  const registeredSources = [];
  try {
    for (const s of NEW_SOURCES) {
      const { rows } = await client.query(
        `INSERT INTO event_sources (site, list_url, mode)
         VALUES ($1, $2, $3)
         ON CONFLICT (site) DO NOTHING
         RETURNING site, list_url, mode`,
        [s.site, s.list_url, s.mode],
      );
      registeredSources.push({ site: s.site, inserted: rows.length > 0 });
    }
  } finally {
    client.release();
  }

  const { events: after } = await mergeAndPurgeEvents(NEW_EVENTS);

  return new Response(
    JSON.stringify({ registeredSources, insertedCount: NEW_EVENTS.length, totalAfter: after.length }, null, 2),
    { headers: { "content-type": "application/json; charset=utf-8" } },
  );
};
