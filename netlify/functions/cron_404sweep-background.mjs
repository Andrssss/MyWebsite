/*
  Active-job 404 sweep (scheduled entry point).

  Thin wrapper: provides an HTTP checker (final status + final URL after
  redirects, optionally the body) and hands it to `sweepActive404` in
  _active_core.mjs, which owns the "which rows / deactivate" logic: final 404 =
  dead, for REDIRECT_DEAD_SOURCES (ydiak, eudiakok) a 200 landing on a
  different path = dead, and for BANNER_DEAD_SOURCES a 200 whose body proves
  the posting closed = dead (bluebird: banner string; talent: the url-id's own
  job object has system_status=2). Also expires the push-only `random_email`
  source (10-day TTL — no scraper, so reconcile can never clean it).
  Triggered by cron_dispatcher_daily.
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

// Cap for banner-rule bodies — bounded memory, but must NOT truncate the
// signal: talent's flight-payload job object sits around the 360–420 KB mark
// of a ~400 KB page, so anything under ~0.5 MB cuts it off.
const BODY_CAP_BYTES = 1_500_000;

// Final HTTP status + final URL after following redirects. Negative status =
// local failure (-1 bad/non-http URL, -2 timeout, -3 network error) — never
// treated as dead. finalUrl lets the sweep detect "dead job → 200 redirect to
// a listing page" sources (REDIRECT_DEAD_SOURCES in _active_core.mjs). With
// `opts.wantBody` the response body is also returned (uncompressed via
// Accept-Encoding: identity) so BANNER_DEAD_SOURCES rules can match on it.
// Exported so ad-hoc maintenance scripts can drive sweepActive404 with the
// exact same checker the scheduled run uses.
export function fetchFinal(url, opts = {}, redirectLeft = 5) {
  const wantBody = opts.wantBody === true;
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
        "Accept-Encoding": wantBody ? "identity" : "gzip,deflate,br",
      },
      timeout: REQUEST_TIMEOUT_MS,
    }, (res) => {
      const code = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(code)) {
        res.resume();
        const loc = res.headers.location;
        if (!loc || redirectLeft <= 0) return resolve({ status: code, finalUrl: url });
        try { return resolve(fetchFinal(new URL(loc, url).toString(), opts, redirectLeft - 1)); }
        catch { return resolve({ status: code, finalUrl: url }); }
      }
      if (!wantBody) {
        res.resume(); // drain; we only need the status line
        return resolve({ status: code, finalUrl: url });
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        if (body.length < BODY_CAP_BYTES) body += chunk;
        else res.destroy(); // triggers 'close'; we already have enough
      });
      res.on("end", () => resolve({ status: code, finalUrl: url, body }));
      res.on("close", () => resolve({ status: code, finalUrl: url, body }));
      res.on("error", () => resolve({ status: code, finalUrl: url, body }));
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
