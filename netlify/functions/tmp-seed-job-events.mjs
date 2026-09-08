// Disposable one-off: manually seed the "job-events" Blob with a curated
// batch of real career events (user-supplied titles/dates/locations/URLs —
// NOT AI-extracted, so no hallucination-guard needed, these are verified
// real links). Uses the exact same mergeAndPurgeEvents() the daily cron
// uses, so dedup-by-url and past-event purging behave identically.
//
// Two same-URL collisions in the source data, resolved by hand:
//   - Óbudai Egyetem Állásbörze (Bécsi út 10-20, Tavaszmező utca 10-21):
//     same announcement page for both dates -> merged into ONE event
//     (date=10-20, endDate=10-21) instead of two rows that would silently
//     clobber each other under the store's url-keyed dedup.
//   - SzakMÁzz (szept 22 őszi állásbörze vs nov 10-11 pályaválasztási
//     kiállítás): genuinely different events, same organizer homepage (no
//     per-event page found) -> disambiguated with harmless #fragments so
//     both survive as distinct rows; the fragment still resolves to the
//     same real page when clicked.
import { mergeAndPurgeEvents } from "./_job_events_store.mjs";

const TOKEN = "tmp-seed-events-7f2c91";

const EVENTS = [
  {
    url: "https://enbudapestem.hu/2026/08/12/ujra-itt-a-budapest-allasborze",
    title: "IV. Budapest Állásbörze",
    date: "2026-09-16",
    endDate: "2026-09-17",
    location: "Biodóm fogadótér, 1146 Budapest, Állatkerti körút 16.",
    company: null,
    type: "allasborze",
    registrationDeadline: null,
    source: "enbudapestem",
  },
  {
    url: "https://awscommunity.eu/",
    title: "AWS Community Day CEE – IT/cloud networking",
    date: "2026-09-17",
    endDate: null,
    location: "Kristály Színtér, Margitsziget",
    company: null,
    type: "konferencia",
    registrationDeadline: null,
    source: "awscommunity",
  },
  {
    url: "https://bkik.hu/esemenyek/minden-esemeny/allasborze-a-xv-keruletben-bkik-reszvetelevel",
    title: "XV. kerületi állásbörze",
    date: "2026-09-18",
    endDate: null,
    location: "XV. kerület, Fő tér",
    company: null,
    type: "allasborze",
    registrationDeadline: null,
    source: "bkik",
  },
  {
    url: "https://www.szakmazzbudapest.hu/1/home#szeptember-allasborze",
    title: "SzakMÁzz! – őszi állásbörze",
    date: "2026-09-22",
    endDate: null,
    location: null,
    company: null,
    type: "allasborze",
    registrationDeadline: null,
    source: "szakmazzbudapest",
  },
  {
    url: "https://campus.epam.com/en/event/188",
    title: "Let's Talk AI – EPAM Campus Edition",
    date: "2026-09-23",
    endDate: null,
    location: "Online",
    company: "EPAM",
    type: "eloadas",
    registrationDeadline: null,
    source: "epam",
  },
  {
    url: "https://services.bme.hu/programajanlo/oszi-karrier-napok/",
    title: "BME Karrier Napok",
    date: "2026-09-21",
    endDate: "2026-10-02",
    location: "BME",
    company: null,
    type: "allasborze",
    registrationDeadline: null,
    source: "bme",
  },
  {
    url: "https://www.muegyetemiallasborze.hu/",
    title: "Műegyetemi Állásbörze",
    date: "2026-10-06",
    endDate: "2026-10-07",
    location: "BME K és Q épület",
    company: null,
    type: "allasborze",
    registrationDeadline: null,
    source: "muegyetemiallasborze",
  },
  {
    url: "https://jobverse.hu/",
    title: "JOBVERSE Állásbörze",
    date: "2026-10-07",
    endDate: "2026-10-08",
    location: "BOK „A” csarnok, 1146 Budapest, Dózsa György út 1.",
    company: null,
    type: "allasborze",
    registrationDeadline: null,
    source: "jobverse",
  },
  {
    url: "https://allasborze.uni-obuda.hu/cms/game-rules",
    title: "Óbudai Egyetem Állásbörze (Bécsi út + Tavaszmező utca)",
    date: "2026-10-20",
    endDate: "2026-10-21",
    location: "Bécsi út 96/B. (okt 20) és Tavaszmező utca 14–18. (okt 21)",
    company: null,
    type: "allasborze",
    registrationDeadline: null,
    source: "uni-obuda",
  },
  {
    url: "https://www.cruisejobfair.com/budapest/",
    title: "Cruise Job Fair Budapest",
    date: "2026-10-30",
    endDate: null,
    location: "Lurdy Konferencia",
    company: null,
    type: "allasborze",
    registrationDeadline: null,
    source: "cruisejobfair",
  },
  {
    url: "https://www.szakmazzbudapest.hu/1/home#palyavalasztasi-kiallitas",
    title: "SzakMÁzz Pályaválasztási Kiállítás",
    date: "2026-11-10",
    endDate: "2026-11-11",
    location: null,
    company: null,
    type: "allasborze",
    registrationDeadline: null,
    source: "szakmazzbudapest",
  },
  {
    url: "https://expomedics.com/events/budapest",
    title: "EXPOMEDICS Karrierbörze",
    date: "2026-11-21",
    endDate: null,
    location: "Budapest",
    company: null,
    type: "allasborze",
    registrationDeadline: null,
    source: "expomedics",
  },
  {
    url: "https://hackerx.org/tech-job-fairs/hungary/budapest/",
    title: "HackerX Budapest Tech Job Fair",
    date: "2026-11-26",
    endDate: null,
    location: null,
    company: null,
    type: "allasborze",
    registrationDeadline: null,
    source: "hackerx",
  },
];

export default async (req) => {
  const auth = req.headers.get("authorization") || "";
  if (auth.replace(/^Bearer\s+/i, "").trim() !== TOKEN) {
    return new Response("unauthorized", { status: 401 });
  }

  const result = await mergeAndPurgeEvents(EVENTS);
  return new Response(JSON.stringify({ ok: true, stored: result.events.length }), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
};
