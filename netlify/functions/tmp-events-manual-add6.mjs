// DISPOSABLE — 2026-09-23. Sixth manual-insert batch. Found via a genuine
// technique breakthrough this round: meetup.com's per-group iCal export
// (https://www.meetup.com/<slug>/events/ical/) returns full structured
// VEVENT data (exact times with timezone, full description, venue) without
// any JS rendering — unlike the group's own /events page, which the
// production pipeline's plain fetch (and even this session's earlier
// WebFetch checks) consistently saw as empty. Checked ~60 Budapest tech
// meetup.com group slugs this way; most are genuinely empty right now, but
// 5 had real upcoming events. (Two more matches — HWSW's kraftie roundtable
// and Digitalk's BeerUP AI Edition — are the SAME real-world events already
// inserted under their non-meetup.com URLs in earlier batches; skipped here
// to avoid a duplicate row for one event.) Delete after use.

import { mergeAndPurgeEvents } from "./_job_events_store.mjs";

const TOKEN = "1da79ff50cbbe92c6d8045541555a734a2ecdeda29a7c330";

const NEW_EVENTS = [
  {
    url: "https://www.meetup.com/devbp-meetup/events/316579206/",
    title: "DevBP #17: Rebuilt & Refactored",
    date: "2026-09-30",
    endDate: null,
    time: "17:30",
    endTime: "20:30",
    location: "Formlabs Budapest office",
    company: "DevBP",
    type: "meetup",
    format: "inperson",
    language: "en",
    free: true,
    registrationDeadline: null,
    deadlineChecked: true,
    source: "meetup",
  },
  {
    url: "https://www.meetup.com/pyladies-budapest/events/316593223/",
    title: "SQL-alapok Pythonból, DuckDB-vel (PyLadies Budapest)",
    date: "2026-09-30",
    endDate: null,
    time: "18:00",
    endTime: "21:00",
    location: "Balance Irodaház, 1139 Budapest, Váci út 99",
    company: "PyLadies Budapest",
    type: "meetup",
    format: "inperson",
    language: "hu",
    free: true,
    registrationDeadline: null,
    deadlineChecked: true,
    source: "meetup",
  },
  {
    url: "https://www.meetup.com/taboola-budapest-tech-meetup/events/316564131/",
    title: "Netflix Prize, 20 Years Later (Taboola Budapest Tech Meetup)",
    date: "2026-09-23",
    endDate: null,
    time: "18:00",
    endTime: "21:00",
    location: "Villányi út 40/B, 1113 Budapest, Hungary",
    company: "Taboola",
    type: "meetup",
    format: "hybrid",
    language: "en",
    free: true,
    registrationDeadline: null,
    deadlineChecked: true,
    source: "meetup",
  },
  {
    url: "https://www.meetup.com/aws-serverless-budapest/events/316255455/",
    title: "AI Opt-Out Mechanics & Self-Service HPC (AWS Serverless Budapest)",
    date: "2026-10-01",
    endDate: null,
    time: "18:00",
    endTime: "21:00",
    location: "Budapest",
    company: "AWS Serverless Budapest",
    type: "meetup",
    format: "inperson",
    language: "en",
    free: true,
    registrationDeadline: null,
    deadlineChecked: true,
    source: "meetup",
  },
  {
    url: "https://www.meetup.com/teszt-tea/events/316668458/",
    title: "HUSTEF Pre-Conference Meetup (Teszt & Tea)",
    date: "2026-10-06",
    endDate: null,
    time: "16:45",
    endTime: "18:45",
    location: "A Grund, Budapest",
    company: "Teszt & Tea",
    type: "meetup",
    format: "inperson",
    language: "en",
    free: true,
    registrationDeadline: null,
    deadlineChecked: true,
    source: "meetup",
  },
];

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });

  const { events: after } = await mergeAndPurgeEvents(NEW_EVENTS);
  return new Response(JSON.stringify({ insertedCount: NEW_EVENTS.length, totalAfter: after.length }, null, 2), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
};
