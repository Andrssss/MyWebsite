// netlify/functions/job-events.js
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

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "https://bakan7.netlify.app",
    },
    body: JSON.stringify(body),
  };
}

exports.handler = async () => {
  try {
    const { readEvents } = await import("./_job_events_store.mjs");
    const { generatedAt, events } = await readEvents();
    return jsonResponse(200, { generatedAt, events });
  } catch (err) {
    console.error("[job-events] Error:", err);
    return jsonResponse(500, { error: err.message });
  }
};
