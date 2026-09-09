// netlify/functions/_ai_events_extract_core.mjs
//
// AI boundary for the job-events pipeline (állásbörzék / előadások / céges
// eventek — 2026-09-08 kibővítve túl a szűken vett állásbörze-fogalmon:
// előadás/webinar/konferencia/meetup is idetartozik, és a `registrationDeadline`
// kiemelt fontosságú mezőként kinyerendő, ha a forrás oldal közli). Mirrors
// _ai_extract_core.mjs (same model, same hallucination guard — a link the
// model returns must literally appear in the source HTML) but the extracted
// shape is an event (title + date + type), not a job posting. Reuses
// everything generic from that module (client, HTML stripping, url
// normalization, field cleanup, response parsing) instead of duplicating it —
// only the event-shaped schema/prompt/validation live here.
//
// extractRegistrationDeadline (2026-09-08): a listing page's HTML is usually
// enough for title/date/location but rarely states a deadline — that, when a
// source gives one at all, is on the event's OWN detail page. This is the
// one-field, single-page follow-up for that; see cron_job_events-background's
// enrichDeadline for when/how often it actually gets called (not every run,
// and not for events already known to have none).
//
// EXTRACT_SYSTEM widened 2026-09-09 (user request): scope was "career events
// aimed at students/job seekers" only, which meant free IT/tech talks and
// conferences with no student framing (a cybersecurity meetup, a webinar)
// never qualified even though they're exactly the kind of thing this feature
// is for. Now any broad-interest IT/tech event counts — narrowed only to
// exclude paid executive/manager-only corporate training and pure vendor
// pitches. Same day, `kibernaptar.hu/esemenylista/` (a general Hungarian
// IT/cybersecurity event calendar) was added to `event_sources` as the first
// source that actually exercises this wider scope — epam/progmasters are
// single-company pages, narrow either way.

import {
  MODEL,
  client,
  stripHtml,
  normalizeUrl,
  cleanField,
  textOf,
  parseJson,
  usageOf,
} from "./_ai_extract_core.mjs";

export { MODEL, estimateCost, fetchListingPage } from "./_ai_extract_core.mjs";

const EVENT_TYPES = ["allasborze", "eloadas", "konferencia", "meetup", "egyeb"];

const EVENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["events"],
  properties: {
    events: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "url", "date", "type"],
        properties: {
          title: { type: "string" },
          url: { type: "string" },
          // ISO "YYYY-MM-DD". A multi-day event's first day.
          date: { type: "string" },
          // ISO "YYYY-MM-DD", or null for a single-day event.
          endDate: { type: ["string", "null"] },
          location: { type: ["string", "null"] },
          company: { type: ["string", "null"] },
          // "allasborze" (job fair) | "eloadas" (talk/presentation/webinar) |
          // "konferencia" | "meetup" | "egyeb" (anything else).
          type: { type: "string", enum: EVENT_TYPES },
          // ISO "YYYY-MM-DD" — the last day one can still register/sign up
          // for the event, or null if the page states no registration or no
          // deadline. High-priority field: extract whenever the page gives it.
          registrationDeadline: { type: ["string", "null"] },
        },
      },
    },
  },
};

const EXTRACT_SYSTEM =
  "You extract upcoming IT/tech-relevant events from a listing page's HTML (in Hungarian or " +
  "English): job fairs / career days / company recruiting events, AND talks, presentations, " +
  "webinars, conferences, and meetups of broad interest to the IT/tech community — NOT limited " +
  "to student- or job-seeker-specific events. A general cybersecurity/dev/tech conference, a " +
  "community meetup, or a free webinar all count, even with no student/career framing at all. " +
  "Skip an event only if it is narrowly paid corporate training aimed at executives/managers " +
  "(not the general IT audience) or reads as a pure vendor sales pitch with no real content. " +
  "Return every DISTINCT event on the page — not job postings, not news articles. For each: " +
  "`title` is the event name; `url` " +
  "is the link to that event's own detail page and MUST be a link that literally appears as an " +
  "href in the provided HTML (absolute, or relative to the given base URL) — never invent, " +
  "guess, or complete a URL. `date` is the event's (first) day as an ISO YYYY-MM-DD date — " +
  "resolve any relative or partial date (e.g. 'szeptember 15.', 'Sept 15') against the given " +
  "reference date, inferring the year if it is omitted. `endDate` is the last day for a " +
  "multi-day event, or null. `type` classifies the event: \"allasborze\" for a job " +
  "fair/career day, \"eloadas\" for a talk/presentation/webinar, \"konferencia\" for a " +
  "conference, \"meetup\" for a meetup, \"egyeb\" if none of those fit. " +
  "`registrationDeadline` is HIGH PRIORITY: if the page states a deadline, cutoff date, or " +
  "\"regisztrálj eddig\" / \"jelentkezési határidő\" / \"register by\" for the event, extract " +
  "it as an ISO YYYY-MM-DD date — resolve relative dates the same way as `date`. Only use null " +
  "if the page truly gives no such deadline (e.g. free walk-in event, or registration open " +
  "until the event itself). Set `location` and `company` to the page's values or null if " +
  "absent. Ignore navigation, ads, and past/archived events — only events that have not " +
  "started yet.";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function cleanDate(v) {
  return typeof v === "string" && DATE_RE.test(v) ? v : null;
}

/**
 * Hallucination-guard + normalize raw event rows: a row survives only if its
 * link actually appears in the source HTML and it carries a valid `date`.
 */
function validateEvents(rawEvents, sourceHtml, baseUrl) {
  const seen = new Set();
  const out = [];
  for (const e of rawEvents || []) {
    if (!e || typeof e.title !== "string" || typeof e.url !== "string") continue;
    const title = e.title.replace(/\s+/g, " ").trim();
    if (title.length < 3) continue;

    const date = cleanDate(e.date);
    if (!date) continue;

    const url = normalizeUrl(e.url, baseUrl);
    if (!url) continue;

    let pathname;
    try {
      pathname = new URL(url).pathname;
    } catch {
      continue;
    }
    if (!sourceHtml.includes(e.url) && !sourceHtml.includes(pathname)) continue;

    if (seen.has(url)) continue;
    seen.add(url);

    const endDate = cleanDate(e.endDate);
    const registrationDeadline = cleanDate(e.registrationDeadline);
    out.push({
      title: title.slice(0, 300),
      url,
      date,
      endDate: endDate && endDate >= date ? endDate : null,
      location: cleanField(e.location),
      company: cleanField(e.company),
      type: EVENT_TYPES.includes(e.type) ? e.type : "egyeb",
      registrationDeadline,
    });
  }
  return out;
}

// Cheaper model for the deadline follow-up (§ below): one small yes/no-ish
// date lookup per event detail page, not a full-page listing extraction — a
// haiku-class model is plenty, and this call recurs once per event that
// lacked a deadline on its listing page (see DEADLINE_SCHEMA usage in
// cron_job_events-background.mjs), so keeping it cheap matters more here
// than for the main per-source EXTRACT_SYSTEM call above.
const DEADLINE_MODEL = process.env.AI_EVENTS_DEADLINE_MODEL || "claude-haiku-4-5";

const DEADLINE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["registrationDeadline"],
  properties: {
    registrationDeadline: { type: ["string", "null"] },
  },
};

const DEADLINE_SYSTEM =
  "You are given one event's own detail page (Hungarian or English). Find whether it states a " +
  "registration deadline, sign-up cutoff, \"regisztrálj eddig\", \"jelentkezési határidő\", or " +
  "\"register by\" date for THIS event. Return it as an ISO YYYY-MM-DD date, resolving any " +
  "relative or partial date against the given reference date. Return null if the page states no " +
  "such deadline — a free walk-in event, registration open until the event itself, or you " +
  "simply cannot find one. Never guess a date that isn't actually stated on the page.";

/**
 * Listing pages often give title/date/location but not a deadline — that,
 * when a source states one at all, usually lives on the event's own detail
 * page. This is the one-field follow-up fetch+extract for that page, kept on
 * a separate (cheap) model since it does far less work than the main
 * extraction. Caller decides WHEN to call this (see the `deadlineChecked`
 * bookkeeping in cron_job_events-background.mjs) — this function itself
 * makes no caching decision, it just answers "what does this page say".
 * @returns {Promise<{registrationDeadline: string|null, usage: object}>}
 */
export async function extractRegistrationDeadline(detailHtml, { referenceDate }) {
  const stripped = stripHtml(detailHtml);
  const res = await client().messages.create({
    model: DEADLINE_MODEL,
    max_tokens: 200,
    output_config: { format: { type: "json_schema", schema: DEADLINE_SCHEMA } },
    system: [{ type: "text", text: DEADLINE_SYSTEM }],
    messages: [
      {
        role: "user",
        content: `Reference date (today): ${referenceDate}\n\n<html>\n${stripped}\n</html>`,
      },
    ],
  });
  const parsed = parseJson(res);
  return { registrationDeadline: cleanDate(parsed?.registrationDeadline), usage: usageOf(res) };
}

/**
 * Send stripped listing HTML, get back a validated events[] array.
 * @returns {Promise<{events: Array, usage: object}>}
 */
export async function extractEventsLLM(rawHtml, { baseUrl }) {
  const stripped = stripHtml(rawHtml);
  const today = new Date().toISOString().slice(0, 10);
  const res = await client().messages.create({
    model: MODEL,
    max_tokens: 8000,
    output_config: { format: { type: "json_schema", schema: EVENT_SCHEMA } },
    system: [{ type: "text", text: EXTRACT_SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "user",
        content:
          `Reference date (today): ${today}\n` +
          `Base URL: ${baseUrl}\n` +
          `Extract every distinct upcoming event from this listing HTML.\n\n<html>\n${stripped}\n</html>`,
      },
    ],
  });
  const raw = parseJson(res)?.events ?? [];
  return { events: validateEvents(raw, rawHtml, baseUrl), usage: usageOf(res) };
}
