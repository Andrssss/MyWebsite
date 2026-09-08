// netlify/functions/_ai_events_extract_core.mjs
//
// AI boundary for the job-events pipeline (állásbörzék / céges eventek).
// Mirrors _ai_extract_core.mjs (same model, same hallucination guard — a
// link the model returns must literally appear in the source HTML) but the
// extracted shape is an event (title + date), not a job posting. Reuses
// everything generic from that module (client, HTML stripping, url
// normalization, field cleanup, response parsing) instead of duplicating it —
// only the event-shaped schema/prompt/validation live here.

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
        required: ["title", "url", "date"],
        properties: {
          title: { type: "string" },
          url: { type: "string" },
          // ISO "YYYY-MM-DD". A multi-day event's first day.
          date: { type: "string" },
          // ISO "YYYY-MM-DD", or null for a single-day event.
          endDate: { type: ["string", "null"] },
          location: { type: ["string", "null"] },
          company: { type: ["string", "null"] },
        },
      },
    },
  },
};

const EXTRACT_SYSTEM =
  "You extract upcoming job fair / career day / company recruiting events from a listing " +
  "page's HTML (in Hungarian or English). Return every DISTINCT event on the page — not job " +
  "postings, not news articles. For each: `title` is the event name; `url` is the link to " +
  "that event's own detail page and MUST be a link that literally appears as an href in the " +
  "provided HTML (absolute, or relative to the given base URL) — never invent, guess, or " +
  "complete a URL. `date` is the event's (first) day as an ISO YYYY-MM-DD date — resolve any " +
  "relative or partial date (e.g. 'szeptember 15.', 'Sept 15') against the given reference " +
  "date, inferring the year if it is omitted. `endDate` is the last day for a multi-day event, " +
  "or null. Set `location` and `company` to the page's values or null if absent. Ignore " +
  "navigation, ads, and past/archived events — only events that have not started yet.";

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
    out.push({
      title: title.slice(0, 300),
      url,
      date,
      endDate: endDate && endDate >= date ? endDate : null,
      location: cleanField(e.location),
      company: cleanField(e.company),
    });
  }
  return out;
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
