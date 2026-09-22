// DISPOSABLE — 2026-09-22. Third manual-insert batch (user asked for
// "next 10" more) — same reasoning as the previous two batches (removed
// after use). Each entry individually re-verified live this session. Only
// found 4 genuinely new, confirmed-free, confirmed-Budapest, dev/tester/
// AI-adjacent events this round — most other leads checked out paid (AI
// Summit Budapest, IEEE Ethical AI Summit, Budapest Snowflake $30,
// Internet Hungary Siófok) or sat on stale/unmaintained listing pages
// (MILAB events page still shows 2024/2025 only, digitalk.tech/content/
// events likewise, Code Week Magyarország's single-day conference date
// wasn't findable, only the 2-week campaign window). Delete after use.

import { mergeAndPurgeEvents } from "./_job_events_store.mjs";

const TOKEN = "1da79ff50cbbe92c6d8045541555a734a2ecdeda29a7c330";

const NEW_EVENTS = [
  {
    url: "https://bkik.hu/esemenyek/minden-esemeny/mesterseges-intelligencia-gyakorlati-workshop-oktober-2",
    title: "Mesterséges intelligencia gyakorlati workshop",
    date: "2026-10-02",
    endDate: null,
    time: "09:00",
    endTime: "13:00",
    location: "Cserepesház Művelődési Központ Zugló, 1144 Budapest, Vezér utca 28/b",
    company: "BKIK",
    type: "eloadas",
    format: "inperson",
    language: "hu",
    free: true,
    registrationDeadline: null,
    deadlineChecked: true,
    source: "bkik",
  },
  {
    url: "https://www.inf.elte.hu/ai-hete-az-elte-informatikai-karan",
    title: "AI hete az ELTE Informatikai Karán",
    date: "2026-10-05",
    endDate: "2026-10-09",
    time: "17:00",
    endTime: "19:00",
    location: "ELTE Lágymányosi Campus, Déli tömb, 1117 Budapest, Pázmány Péter sétány 1/C",
    company: "ELTE Informatikai Kar",
    type: "eloadas",
    format: "inperson",
    language: "hu",
    free: true,
    registrationDeadline: null,
    deadlineChecked: true,
    source: "elte",
  },
  {
    url: "https://www.cruisejobfair.com/budapest/",
    title: "Cruise Job Fair Budapest",
    date: "2026-10-30",
    endDate: null,
    time: "11:00",
    endTime: "16:00",
    location: "Lurdy Konferencia, Budapest",
    company: "Cruise Job Fair",
    type: "allasborze",
    format: "inperson",
    language: "en",
    free: true,
    registrationDeadline: null,
    deadlineChecked: true,
    source: "cruisejobfair",
  },
  {
    url: "https://digitalk.tech/events/beerup-cybersecurity-edition",
    title: "BeerUP Cybersecurity Edition",
    date: "2026-11-12",
    endDate: null,
    time: "18:00",
    endTime: null,
    location: "Városmajori Szalonka, 1122 Budapest, Városmajor hrsz. 6835/17",
    company: "Digitalk-tech",
    type: "meetup",
    format: "inperson",
    language: "hu",
    free: true,
    registrationDeadline: null,
    deadlineChecked: true,
    source: "digitalk",
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
