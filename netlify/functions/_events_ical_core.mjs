// netlify/functions/_events_ical_core.mjs
//
// Deterministic (non-AI) event extraction for meetup.com groups, via their
// own per-group iCal export (2026-09-23, user request — "keresd az
// eseményeket" turned into a long manual WebSearch/WebFetch grind because
// meetup.com's own `/<group>/events/` listing page renders its event list
// client-side: a plain fetch (this pipeline's fetchListingPage) sees an
// empty shell, and even WebFetch's own rendering consistently reported "0
// events" for groups that, per this technique, actually had one).
// `https://www.meetup.com/<slug>/events/ical/` returns a real RFC 5545
// VCALENDAR with one VEVENT per upcoming event — exact start/end time
// (already in Europe/Budapest wall-clock, no timezone math needed), title,
// URL, and a free-text description — with ZERO LLM calls, same "no AI, only
// sources that are simple or have an API" bar as the jsonld path.
//
// No structured price/location/format fields exist in this format (unlike
// jsonld's `offers.price`) — those live only in the free-text DESCRIPTION,
// so this module leans on deterministic keyword heuristics instead:
//   - `free`: DEFAULT TRUE (meetup.com community meetups overwhelmingly are;
//     confirmed live across ~10 real events this session, only the two
//     actual ticketed-conference posts — KCD Budapest, a partner conference
//     cross-posted into a meetup group — had real paid language). Only
//     flips to false on a STRONG signal tied to attending THIS event
//     ("jegyértékesítés", "belépőjegy", an explicit price figure near a
//     price word). A bare mention of "ticket"/"jegy" alone is deliberately
//     NOT enough — a free meetup can still mention a DIFFERENT paid event in
//     passing (e.g. a conference discount code), and one real example this
//     session (Teszt & Tea cross-promoting a HUSTEF ticket discount) would
//     have been wrongly flagged paid by a bare-word check.
//   - `location`: every source registered under this mode is a Budapest-
//     scoped meetup.com group by curation (that's the whole reason it was
//     picked), so this defaults to `"Budapest"` rather than trying to parse
//     a street address out of free text — good enough for the
//     looksBudapestRelevant() store filter, which only needs "budapest" to
//     appear in the string for an inperson event to pass.
//   - `format`/`language`: simple keyword/character-frequency heuristics,
//     same spirit as classifyFormat in _events_jsonld_core.mjs.
//   - `type`: always "meetup" — every source on this path is by definition
//     a meetup.com group, no title-keyword guessing needed.
//   - `registrationDeadline`: always null, same "no AI follow-up" trade as
//     the jsonld path.

import { cleanField } from "./_ai_extract_core.mjs";

// Un-fold RFC 5545 line continuations (a line starting with a space or tab
// continues the previous line) before doing anything line-oriented.
function unfold(ical) {
  return ical.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "");
}

function unescapeIcalText(v) {
  return v
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\")
    .trim();
}

function getField(block, name) {
  // Matches "NAME:value" or "NAME;PARAM=x:value" at the start of a line.
  const m = block.match(new RegExp(`^${name}(?:;[^:\\n]*)?:(.*)$`, "m"));
  return m ? m[1].trim() : null;
}

const DATE_TIME_RE = /(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/;

function parseDateTime(v) {
  const m = v && v.match(DATE_TIME_RE);
  if (!m) return { date: null, time: null };
  const [, y, mo, d, hh, mm] = m;
  return { date: `${y}-${mo}-${d}`, time: `${hh}:${mm}` };
}

const STRONG_PAID_RE =
  /jegy[eé]rt[eé]kes[ií]t[eé]s|bel[eé]p[oő]jegy|jegyet\s+kell\s+v[aá]s[aá]rolni|buy\s+tickets?|ticket\s+price|r[eé]szv[eé]teli\s+d[ií]j(?!.*ingyenes)|early\s+bird\s+(price|ticket|d[ií]j)|\b\d[\d.,]*\s?(Ft|HUF|EUR|USD)\b/i;

function classifyFree(description) {
  return !STRONG_PAID_RE.test(description || "");
}

const ONLINE_RE = /\bonline\b/i;
const INPERSON_HINT_RE = /helysz[ií]n|venue|in[- ]person|utca|krt\.?|k[oö]r[uú]t|iroda|office/i;

function classifyFormat(description) {
  const hasOnline = ONLINE_RE.test(description || "");
  const hasInPerson = INPERSON_HINT_RE.test(description || "");
  if (hasOnline && hasInPerson) return "hybrid";
  if (hasOnline) return "online";
  return "inperson";
}

function classifyLanguage(description) {
  const huChars = (description || "").match(/[áéíóöőúüű]/gi) || [];
  return huChars.length > 10 ? "hu" : "en";
}

/**
 * Parse a meetup.com group's iCal export into this pipeline's event shape.
 * @returns {Array} event rows
 */
export function extractEventsIcal(icalText, { defaultLocation = "Budapest" } = {}) {
  const text = unfold(icalText || "");
  const blocks = text.split("BEGIN:VEVENT").slice(1).map((b) => b.split("END:VEVENT")[0]);
  const events = [];
  const seen = new Set();

  for (const block of blocks) {
    const rawTitle = getField(block, "SUMMARY");
    const rawUrl = getField(block, "URL");
    if (!rawTitle || !rawUrl) continue;

    const title = unescapeIcalText(rawTitle).replace(/\s+/g, " ").slice(0, 300);
    if (title.length < 3) continue;

    const url = rawUrl.trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);

    const { date, time } = parseDateTime(getField(block, "DTSTART"));
    if (!date) continue;
    const { date: endDateRaw, time: endTime } = parseDateTime(getField(block, "DTEND"));
    const endDate = endDateRaw && endDateRaw !== date ? endDateRaw : null;

    const description = unescapeIcalText(getField(block, "DESCRIPTION") || "");

    events.push({
      title,
      url,
      date,
      endDate,
      time,
      endTime: endDate ? null : endTime, // a same-day end TIME; a multi-day endDate makes endTime ambiguous, drop it
      location: cleanField(defaultLocation),
      company: null,
      type: "meetup",
      format: classifyFormat(description),
      language: classifyLanguage(description),
      free: classifyFree(description),
      registrationDeadline: null,
      deadlineChecked: true,
    });
  }

  return events;
}
