// DISPOSABLE — 2026-09-23. Fourth manual-insert batch (user asked for "10
// more" twice now) — same reasoning as the previous batches (removed after
// use). This round tried a new technique (Eventbrite's Budapest category
// pages carry real schema.org Event JSON-LD in their search-results
// ItemList, unlike meetup.com) across 7 categories (technology-meetup,
// tech-conferences, ai, artificial-intelligence, software-testing,
// software-development, data-science, startups, networking) plus direct
// searches for SZTAKI, Codecool, Hungarian Testing Board, Nokia/Ericsson/
// Bosch, PPKE-ITK, and university/company event pages. Eventbrite's
// Budapest inventory turned out small and largely non-tech (dating/social/
// finance events dominate every category); the other leads were either
// not-yet-announced for late 2026, already-past dates, or on pages that
// simply don't list anything past ~September 2026 yet. Exactly ONE new
// genuinely-relevant, confirmed-free event survived verification. Delete
// after use.

import { mergeAndPurgeEvents } from "./_job_events_store.mjs";

const TOKEN = "1da79ff50cbbe92c6d8045541555a734a2ecdeda29a7c330";

const NEW_EVENTS = [
  {
    url: "https://www.eventbrite.com/e/beerup-ai-edition-tickets-1996973372113",
    title: "BeerUP AI Edition",
    date: "2026-10-15",
    endDate: null,
    time: "18:00",
    endTime: "21:00",
    location: "Mixát, Krúdy Utca 7, 1088 Budapest",
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
