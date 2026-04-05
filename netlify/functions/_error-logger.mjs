import { getStore } from "@netlify/blobs";

const STORE_NAME = "fetch-error-logs";

/**
 * Log an HTTP/network fetch error to Netlify Blobs.
 *
 * @param {string} cronJob  – cron job identifier, e.g. "cron_jobs_3"
 * @param {object} opts
 * @param {string} opts.url     – the URL that was fetched
 * @param {string} opts.message – the error message
 * @param {object} [opts.extra] – any additional context
 */
export async function logFetchError(cronJob, { url, message, extra } = {}) {
  try {
    const store = getStore(STORE_NAME);
    const now = new Date();

    // Try to extract HTTP status code from error message (format: "HTTP 404 for ...")
    let statusCode = null;
    const httpMatch = String(message || "").match(/HTTP\s+(\d+)/i);
    if (httpMatch) statusCode = parseInt(httpMatch[1], 10);

    const ts = now.toISOString().replace(/[:.]/g, "-");
    const key = `${cronJob}/${ts}.json`;

    const entry = {
      cronJob,
      url: url || null,
      date: now.toISOString(),
      statusCode,
      message: message || "",
      extra: extra || null,
    };

    await store.set(key, JSON.stringify(entry, null, 2));
    console.log(`[error-logger] ${cronJob}: ${statusCode || "ERR"} – ${url}`);
  } catch (logErr) {
    console.error("[error-logger] failed to write log:", logErr.message);
  }
}

/**
 * Wrap a Netlify scheduled function handler with a timeout guard.
 * If the handler takes longer than `limitMs`, the timeout is logged
 * as an error via logFetchError before returning.
 *
 * @param {string} cronJob  – cron job identifier, e.g. "cron_experience"
 * @param {Function} handler – the original async handler
 * @param {number} [limitMs=25000] – timeout threshold in ms (default 25s, safe margin before Netlify's 26s limit)
 * @returns {Function} wrapped handler
 */
export function withTimeout(cronJob, handler, limitMs = 25000) {
  return async (...args) => {
    const start = Date.now();
    let logged = false;

    // Fire a safety timer BEFORE Netlify kills the process
    const timer = setTimeout(async () => {
      logged = true;
      const elapsed = Date.now() - start;
      await logFetchError(cronJob, {
        url: null,
        message: `Timeout: still running after ${(elapsed / 1000).toFixed(1)}s (limit: ${(limitMs / 1000).toFixed(0)}s)`,
        extra: { elapsedMs: elapsed, limitMs },
      });
      console.error(`[${cronJob}] TIMEOUT after ${(elapsed / 1000).toFixed(1)}s`);
    }, limitMs);

    try {
      const result = await handler(...args);
      clearTimeout(timer);
      return result;
    } catch (err) {
      clearTimeout(timer);
      if (!logged) {
        const elapsed = Date.now() - start;
        await logFetchError(cronJob, {
          url: null,
          message: `Handler crashed after ${(elapsed / 1000).toFixed(1)}s: ${err.message}`,
          extra: { elapsedMs: elapsed, stack: err.stack },
        });
      }
      throw err;
    }
  };
}
