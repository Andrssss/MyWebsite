// DISPOSABLE — 2026-09-23. Fifth manual-insert batch (user keeps asking for
// "10 more") — same reasoning as previous batches (removed after use). This
// round found university lecture-series pages (BME VIK esemenyek, ELTE
// eltefeszt) that the earlier passes hadn't checked. Delete after use.

import { mergeAndPurgeEvents } from "./_job_events_store.mjs";

const TOKEN = "1da79ff50cbbe92c6d8045541555a734a2ecdeda29a7c330";

const NEW_EVENTS = [
  {
    url: "https://tudprog.bme.hu/kutej/2026/vik/",
    title: "Kutatók Éjszakája 2026 – BME VIK",
    date: "2026-09-25",
    endDate: null,
    time: "15:30",
    endTime: "22:00",
    location: "BME Villamosmérnöki és Informatikai Kar, Budapest",
    company: "BME VIK",
    type: "eloadas",
    format: "inperson",
    language: "hu",
    free: true,
    registrationDeadline: null,
    deadlineChecked: true,
    source: "bme",
  },
  {
    url: "https://vik.bme.hu/esemenyek/",
    title: "Stefan Steinle (SAP) előadás – AI hatása a vállalati működésre",
    date: "2026-09-30",
    endDate: null,
    time: "14:00",
    endTime: "15:00",
    location: "BME Q épület, B szárny, földszint F09, Budapest",
    company: "SAP",
    type: "eloadas",
    format: "inperson",
    language: "en",
    free: true,
    registrationDeadline: null,
    deadlineChecked: true,
    source: "bme",
  },
  {
    url: "https://www.inf.elte.hu/eltefeszt-2026",
    title: "ELTEfeszt 2026 – ELTE Informatikai Kar nyílt napja",
    date: "2026-10-16",
    endDate: null,
    time: "08:00",
    endTime: "14:00",
    location: "ELTE Trefort-kert, 1088 Budapest, Múzeum krt. 4.",
    company: "ELTE Informatikai Kar",
    type: "eloadas",
    format: "inperson",
    language: "hu",
    free: true,
    registrationDeadline: null,
    deadlineChecked: true,
    source: "elte",
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
