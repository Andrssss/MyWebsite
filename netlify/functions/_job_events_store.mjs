// netlify/functions/_job_events_store.mjs
//
// "job-events" Netlify Blob: upcoming állásbörzék / céges eventek, gyűjtve
// AI-extrakcióval (_ai_events_extract_core.mjs) az `event_sources` táblában
// regisztrált oldalakról. Ugyanaz a minta, mint a "job-stats" blob
// (_daily_stats_store.mjs) — derived, teljesen újraépíthető adat, nincs rá
// relációs hozzáférési minta, egyetlen napi cron írja.
//
// Store: "job-events", egyetlen kulcs "latest.json":
//   { generatedAt, events: [{ url, title, date, endDate, location, company,
//                             type, registrationDeadline, deadlineChecked,
//                             source, firstSeenAt }] }
// `url` a sor identitása (mint job_posts-nál). `date` (és opcionális
// `endDate`) ISO "YYYY-MM-DD". Egy esemény akkor "múltbeli", ha a záró
// (vagy hiányában a kezdő) dátuma korábbi a mai UTC napnál — ilyeneket
// minden futás kitöröl a blobból, ez a "múltban levőket kitörli" garancia.
// `type`/`registrationDeadline`/`deadlineChecked` a
// cron_job_events-background.mjs+_ai_events_extract_core.mjs párosból
// érkeznek (2026-09-08) — ez a modul mezőagnosztikus, csak áthalad rajtuk,
// nincs itt külön kezelésük. `deadlineChecked` belső bookkeeping — az
// allasfigyelo /events oldala (a blob egyetlen olvasója) nem használja,
// csak azt jelzi ennek a modulnak, hogy a határidő-follow-up már lefutott
// erre a sorra, ne fizessen rá újra egy örökre üres mezőre.

import { getStore } from "@netlify/blobs";

const STORE_NAME = "job-events";
const BLOB_KEY = "latest.json";

function store() {
  return getStore({ name: STORE_NAME, consistency: "strong" });
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

function isPast(event, today) {
  const cutoff = event.endDate || event.date;
  return !cutoff || cutoff < today;
}

function sortByDate(events) {
  return [...events].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export async function readEvents() {
  const raw = await store().get(BLOB_KEY, { type: "json" });
  if (!raw || !Array.isArray(raw.events)) {
    return { generatedAt: null, events: [] };
  }
  return raw;
}

async function writeEvents(events) {
  const payload = {
    generatedAt: new Date().toISOString(),
    events: sortByDate(events),
  };
  await store().setJSON(BLOB_KEY, payload);
  return payload;
}

/**
 * Beolvasztja `incoming` eseményeket a tárolt listába (upsert `url` szerint,
 * megőrizve az eredeti `firstSeenAt`-et), majd eldobja a lejárt sorokat —
 * akkor is, ha `incoming` üres, hogy a takarítás önmagában, forrás nélkül is
 * lefusson minden ütemezett futáskor.
 */
export async function mergeAndPurgeEvents(incoming) {
  const today = todayUTC();
  const { events: current } = await readEvents();

  const byUrl = new Map(current.map((e) => [e.url, e]));
  const now = new Date().toISOString();
  for (const ev of incoming) {
    if (!ev?.url) continue;
    const existing = byUrl.get(ev.url);
    byUrl.set(ev.url, { ...ev, firstSeenAt: existing?.firstSeenAt || now });
  }

  const merged = [...byUrl.values()].filter((e) => !isPast(e, today));
  return writeEvents(merged);
}
