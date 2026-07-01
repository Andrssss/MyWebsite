/*
  Active-job 404 sweep (scheduled entry point).

  Thin wrapper: provides an HTTP status checker and hands it to
  `sweepActive404` in _active_core.mjs, which owns the "which rows / deactivate"
  logic. Deactivates every active non-LinkedIn job whose own URL returns HTTP 404.
  See _active_core.mjs for the rationale (safety net for windowed/synthetic-URL
  sources that reconcileActive can't cover). Triggered by cron_dispatcher_daily.
*/

import { Pool } from "pg";
import http from "http";
import https from "https";
import { withTimeout } from "./_error-logger.mjs";
import { sweepActive404 } from "./_active_core.mjs";

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

const REQUEST_TIMEOUT_MS = 15000;

// Final HTTP status after following redirects. Negative = local failure
// (-1 bad/non-http URL, -2 timeout, -3 network error) — never treated as 404.
function fetchStatus(url, redirectLeft = 5) {
  return new Promise((resolve) => {
    let parsed;
    try { parsed = new URL(url); } catch { return resolve(-1); }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return resolve(-1);

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
        if (!loc || redirectLeft <= 0) return resolve(code);
        try { return resolve(fetchStatus(new URL(loc, url).toString(), redirectLeft - 1)); }
        catch { return resolve(code); }
      }
      resolve(code);
    });
    req.on("timeout", () => { req.destroy(); resolve(-2); });
    req.on("error", () => resolve(-3));
    req.end();
  });
}

const _runJob = withTimeout("cron_404sweep-background", async () => {
  const client = await pool.connect();
  try {
    const rc = await sweepActive404(client, fetchStatus);
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
