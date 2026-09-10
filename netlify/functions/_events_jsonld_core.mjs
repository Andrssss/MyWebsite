// netlify/functions/_events_jsonld_core.mjs
//
// Deterministic (non-AI) event extraction for listing pages that embed
// schema.org/Event JSON-LD directly (2026-09-11, user request: only scrape
// sources that are "simple or have an API" — no AI calls for those).
// kibernaptar.hu's WordPress events-calendar plugin emits the full event
// list as one <script type="application/ld+json"> array right on the
// listing page — title/date/location for free, zero LLM calls, zero token
// cost, and immune to the AI hallucination class of bug entirely (there's
// no model in this path to invent a URL). ivsz.hu and mvisz.hu were checked
// too (2026-09-11) and have no per-event structured data, only generic
// Yoast SEO boilerplate — not "simple", so they stay off this path (see
// cron_job_events-background.mjs for how `event_sources.mode` picks which
// extractor a source uses).
//
// Caveat found live: `eventAttendanceMode` on kibernaptar is ALWAYS
// "OfflineEventAttendanceMode" regardless of the event's real format (wrong
// on 2 known-online events, confirmed by hand) — the plugin's default,
// never actually configured by organizers. So `format` is derived from
// `location.name` instead: literally contains "online" -> online, else
// inperson. This under-detects hybrid (no reliable signal for it here) but
// never over-claims online, the safer direction to be wrong in for a
// "should I click this" filter chip.
//
// `type` has no schema.org equivalent — classified from the title by a
// small keyword list, the same pattern as job_categories' keyword-based
// classification elsewhere in this repo. `registrationDeadline` has no
// structured field either and is left null (deadlineChecked: true) — no
// per-event detail-page follow-up like the AI path's enrichDeadline does;
// that one-field lookup was itself an AI call, so dropping it is the actual
// "no AI" trade this module makes, not an oversight.

import { load as cheerioLoad } from "cheerio";
import { normalizeUrl, cleanField } from "./_ai_extract_core.mjs";

function decodeEntities(str) {
  if (!str) return str;
  return cheerioLoad(`<div>${str}</div>`)("div").text();
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}/;

function dateOnly(iso) {
  return typeof iso === "string" && DATE_RE.test(iso) ? iso.slice(0, 10) : null;
}

const TYPE_KEYWORDS = [
  [/állásbörze|job\s*fair|karrier\s*nap/i, "allasborze"],
  [/meetup/i, "meetup"],
  [/konferenci|conference|summit|\bconf\b|expo|community day/i, "konferencia"],
];

function classifyType(title) {
  for (const [re, type] of TYPE_KEYWORDS) {
    if (re.test(title)) return type;
  }
  return "eloadas";
}

function classifyFormat(locationName) {
  return locationName && /online/i.test(locationName) ? "online" : "inperson";
}

function formatLocation(loc) {
  if (!loc) return null;
  const name = loc.name ? decodeEntities(loc.name).replace(/\s+/g, " ").trim() : "";
  const locality = loc.address?.addressLocality
    ? decodeEntities(loc.address.addressLocality).trim()
    : "";
  if (!name) return locality || null;
  if (!locality || name.includes(locality)) return name;
  return `${name}, ${locality}`;
}

/**
 * Parse every schema.org Event out of a page's JSON-LD script tags —
 * cheerio + JSON.parse only, no network, no LLM.
 * @returns {Array} event rows in this pipeline's shape
 */
export function extractEventsJsonLd(html, { baseUrl }) {
  const $ = cheerioLoad(html);
  const events = [];
  const seen = new Set();

  $('script[type="application/ld+json"]').each((_, el) => {
    let parsed;
    try {
      parsed = JSON.parse($(el).contents().text());
    } catch {
      return;
    }
    const items = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.["@graph"]) ? parsed["@graph"] : [parsed];

    for (const item of items) {
      if (!item || item["@type"] !== "Event") continue;

      const title = decodeEntities(item.name || "").replace(/\s+/g, " ").trim();
      if (title.length < 3) continue;

      const url = normalizeUrl(item.url, baseUrl);
      if (!url || seen.has(url)) continue;
      seen.add(url);

      const date = dateOnly(item.startDate);
      if (!date) continue;
      const endRaw = dateOnly(item.endDate);
      const endDate = endRaw && endRaw !== date ? endRaw : null;

      const locationName = item.location?.name ? decodeEntities(item.location.name) : null;

      events.push({
        title: title.slice(0, 300),
        url,
        date,
        endDate,
        location: formatLocation(item.location),
        company: cleanField(item.organizer?.name ? decodeEntities(item.organizer.name) : null),
        type: classifyType(title),
        format: classifyFormat(locationName),
        language: "hu",
        registrationDeadline: null,
        deadlineChecked: true,
      });
    }
  });

  return events;
}
