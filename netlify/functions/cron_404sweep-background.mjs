/*
  Active-job 404 sweep (scheduled entry point).

  Thin wrapper: provides an HTTP checker (final status + final URL after
  redirects) and hands it to `sweepActive404` in _active_core.mjs, which owns
  the "which rows / deactivate" logic: final 404 = dead, and for
  REDIRECT_DEAD_SOURCES (ydiak) a 200 landing on a different path = dead.
  Also expires the push-only `random_email` source (10-day TTL — no scraper,
  so reconcile can never clean it). Triggered by cron_dispatcher_daily.
*/

import { Pool } from "pg";
import http from "http";
import https from "https";
import { withTimeout } from "./_error-logger.mjs";
import { sweepActive404, expireAgedPushSource } from "./_active_core.mjs";

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

const REQUEST_TIMEOUT_MS = 15000;

// Final HTTP status + final URL after following redirects. Negative status =
// local failure (-1 bad/non-http URL, -2 timeout, -3 network error) — never
// treated as dead. finalUrl lets the sweep detect "dead job → 200 redirect to
// a listing page" sources (REDIRECT_DEAD_SOURCES in _active_core.mjs).
function fetchFinal(url, redirectLeft = 5) {
  return new Promise((resolve) => {
    let parsed;
    try { parsed = new URL(url); } catch { return resolve({ status: -1, finalUrl: null }); }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return resolve({ status: -1, finalUrl: null });
    }

    const lib = parsed.protocol === "https:" ? https : http;
    const req = lib.request(parsed, {
      method: "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/json,*/*;q=0.8",
        "Accept-Language": "hu-HU,hu;q=0.9,en;q=0.8",
        "Accept-Encoding": "gzip,deflate,br",
      },
      timeout: REQUEST_TIMEOUT_MS,
    }, (res) => {
      const code = res.statusCode || 0;
      res.resume(); // drain; we only need the status line
      if ([301, 302, 303, 307, 308].includes(code)) {
        const loc = res.headers.location;
        if (!loc || redirectLeft <= 0) return resolve({ status: code, finalUrl: url });
        try { return resolve(fetchFinal(new URL(loc, url).toString(), redirectLeft - 1)); }
        catch { return resolve({ status: code, finalUrl: url }); }
      }
      resolve({ status: code, finalUrl: url });
    });
    req.on("timeout", () => { req.destroy(); resolve({ status: -2, finalUrl: null }); });
    req.on("error", () => resolve({ status: -3, finalUrl: null }));
    req.end();
  });
}

const _runJob = withTimeout("cron_404sweep-background", async () => {
  const client = await pool.connect();
  try {
    // random_email is a push-only source (no scraper → no reconcile): rows get
    // a 10-day TTL instead (user decision 2026-07-04).
    const expired = await expireAgedPushSource(client, "random_email", 10);
    console.log(`[404sweep] random_email 10-day expiry: ${expired} deactivated`);

    const rc = await sweepActive404(client, fetchFinal);
    console.log(`[404sweep] ${JSON.stringify(rc)}`);
  } finally {
    client.release();
  }
  return new Response("OK");
});

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  const expected = process.env.CRON_SECRET;
  if (!expected || token !== expected) {
    return new Response("Unauthorized", { status: 401 });
  }
  return _runJob(request);
};
