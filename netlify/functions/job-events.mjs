// netlify/functions/job-events.mjs
// API endpoint: GET /.netlify/functions/job-events
// Returns the upcoming job fair / company event list from the "job-events"
// Blob (_job_events_store.mjs) — already purged of past events on write, so
// this endpoint does no filtering, just reads and returns.
//
// Public on purpose, same reasoning as job-stats.js: non-sensitive data. The
// actual pestidev.hu consumption is expected to mirror job-stats' pattern —
// a server-side Netlify Blobs read (this site's siteID + a PAT), not a
// browser fetch — so CORS is pinned to this site's own origin same as
// job-stats.js, not opened up.
//
// Rewritten from a CommonJS `exports.handler` (.js) function to this ESM
// `export default` (.mjs, Functions API v2) shape 2026-09-09 — v1-style
// `exports.handler` functions on this site do NOT get Netlify's automatic
// Blobs context injected (see reviews.mjs / CLAUDE.md: this was the other
// pre-existing function confirmed broken with MissingBlobsEnvironmentError
// when that gotcha was first found, left unfixed at the time).

import { readEvents } from "./_job_events_store.mjs";

function jsonResponse(statusCode, body) {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "https://bakan7.netlify.app",
    },
  });
}

export default async () => {
  try {
    const { generatedAt, events } = await readEvents();
    return jsonResponse(200, { generatedAt, events });
  } catch (err) {
    console.error("[job-events] Error:", err);
    return jsonResponse(500, { error: err.message });
  }
};
