// DISPOSABLE — 2026-09-22. Second manual-insert batch, same reasoning as
// tmp-events-manual-add.mjs (removed after its first use) — user asked for
// more events, specifically free dev/tester/AI-leaning ones, after the
// board dropped to 5 rows. Each entry below was individually re-verified
// live via WebSearch/WebFetch this session (date, time, venue, free/paid)
// rather than trusted from the pre-incident data dump. Delete after use.

import { mergeAndPurgeEvents } from "./_job_events_store.mjs";

const TOKEN = "1da79ff50cbbe92c6d8045541555a734a2ecdeda29a7c330";

const NEW_EVENTS = [
  {
    url: "https://services.bme.hu/programajanlo/oszi-karrier-napok/",
    title: "BME Karrier Napok 2026 ősz",
    date: "2026-09-21",
    endDate: "2026-10-02",
    time: null,
    endTime: null,
    location: "BME, Budapest",
    company: "BME",
    type: "allasborze",
    format: "inperson",
    language: "hu",
    free: true,
    registrationDeadline: null,
    deadlineChecked: true,
    source: "bme",
  },
  {
    url: "https://www.meetup.com/gloster-ai-klub/events/316496740/",
    title: "Saving Tokens in Agent-Based Dev Workflows",
    date: "2026-09-24",
    endDate: null,
    time: "17:00",
    endTime: "19:00",
    location: "Gloster Digital, 1068 Budapest, Dózsa György út 84/B.",
    company: "Gloster AI Klub",
    type: "meetup",
    format: "inperson",
    language: "en",
    free: true,
    registrationDeadline: null,
    deadlineChecked: true,
    source: "meetup",
  },
  {
    url: "https://www.muegyetemiallasborze.hu/",
    title: "Műegyetemi Állásbörze 2026 ősz",
    date: "2026-10-06",
    endDate: "2026-10-07",
    time: null,
    endTime: null,
    location: "BME K és Q épület, Műegyetem rakpart 3., Budapest",
    company: null,
    type: "allasborze",
    format: "inperson",
    language: "hu",
    free: true,
    registrationDeadline: null,
    deadlineChecked: true,
    source: "muegyetemiallasborze",
  },
  {
    url: "https://jobverse.hu/en/on-site-infos/",
    title: "JOBVERSE Állásbörze 2026 ősz",
    date: "2026-10-07",
    endDate: "2026-10-08",
    time: "10:00",
    endTime: "19:00",
    location: "BOK \"A\" csarnok, Dózsa György út 1., Budapest",
    company: "JOBVERSE",
    type: "allasborze",
    format: "inperson",
    language: "hu",
    free: true,
    registrationDeadline: null,
    deadlineChecked: true,
    source: "jobverse",
  },
  {
    url: "https://allasborze.uni-obuda.hu/",
    title: "Óbudai Egyetem Állásbörze 2026 ősz",
    date: "2026-10-20",
    endDate: "2026-10-21",
    time: null,
    endTime: null,
    location: "Óbudai Egyetem (Bécsi út + Tavaszmező utca), Budapest",
    company: "Óbudai Egyetem",
    type: "allasborze",
    format: "inperson",
    language: "hu",
    free: true,
    registrationDeadline: null,
    deadlineChecked: true,
    source: "uni-obuda",
  },
  {
    url: "https://hackerx.org/tech-job-fairs/hungary/budapest/",
    title: "HackerX Budapest Tech Job Fair",
    date: "2026-11-26",
    endDate: null,
    time: "19:00",
    endTime: "22:00",
    location: "Budapest",
    company: "HackerX",
    type: "allasborze",
    format: "inperson",
    language: "en",
    free: true,
    registrationDeadline: null,
    deadlineChecked: true,
    source: "hackerx",
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
