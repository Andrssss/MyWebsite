import { getStore } from "@netlify/blobs";

const STORE_NAME = "fetch-error-logs";

/* ── per-run error queue (flushed automatically by withTimeout) ── */
const pendingErrors = new Map();

/**
 * Queue a fetch / network error for batch logging.
 * All errors collected during one cron run are written into a **single**
 * Netlify Blob entry when the run finishes (via `withTimeout`).
 *
 * @param {string} cronJob  – cron job identifier, e.g. "cron_jobs_3"
 * @param {object} opts
 * @param {string} opts.url     – the URL that was fetched
 * @param {string} opts.message – the error message
 * @param {object} [opts.extra] – any additional context
 */
export function logFetchError(cronJob, { url, message, extra } = {}) {
  let statusCode = null;
  const httpMatch = String(message || "").match(/HTTP\s+(\d+)/i);
  if (httpMatch) statusCode = parseInt(httpMatch[1], 10);

  if (!pendingErrors.has(cronJob)) pendingErrors.set(cronJob, []);
  pendingErrors.get(cronJob).push({
    url: url || null,
    statusCode,
    message: message || "",
    extra: extra || null,
    time: new Date().toISOString(),
  });
  console.log(`[error-logger] ${cronJob}: queued ${statusCode || "ERR"} – ${url}`);
}

/**
 * Flush all queued errors for a cron job into **one** Netlify Blob entry.
 * Retries up to 2 times on failure. Called automatically by `withTimeout`.
 */
export async function flushErrors(cronJob) {
  const errors = pendingErrors.get(cronJob);
  if (!errors || errors.length === 0) return;

  try {
    const store = getStore(STORE_NAME);
    const now = new Date();
    const ts = now.toISOString().replace(/[:.]/g, "-");
    const key = `${cronJob}/${ts}.json`;

    const entry = {
      cronJob,
      date: now.toISOString(),
      errorCount: errors.length,
      errors,
    };

    await store.set(key, JSON.stringify(entry, null, 2));
    pendingErrors.delete(cronJob);
    console.log(`[error-logger] ${cronJob}: flushed ${errors.length} error(s)`);
  } catch (logErr) {
    console.error(`[error-logger] flush failed: ${logErr.message}`);
  }
}

/**
 * Wrap a Netlify scheduled function handler with a timeout guard.
 * If the handler takes longer than `limitMs`, the timeout is logged
 * as an error via logFetchError before returning.
 * All queued errors are flushed into a single blob at the end of the run.
 *
 * @param {string} cronJob  – cron job identifier, e.g. "cron_experience"
 * @param {Function} handler – the original async handler
 * @param {number} [limitMs=29000] – timeout threshold in ms (default 29s)
 * @returns {Function} wrapped handler
 */
export function withTimeout(cronJob, handler, limitMs = 29000) {
  return async (...args) => {
    const start = Date.now();

    const TIMED_OUT = Symbol("TIMED_OUT");

    const timeoutPromise = new Promise((resolve) => {
      setTimeout(() => resolve(TIMED_OUT), limitMs);
    });

    const handlerPromise = (async () => {
      try {
        const result = await handler(...args);
        await flushErrors(cronJob);
        return result;
      } catch (err) {
        const elapsed = Date.now() - start;
        logFetchError(cronJob, {
          url: null,
          message: `Handler crashed after ${(elapsed / 1000).toFixed(1)}s: ${err.message}`,
          extra: { elapsedMs: elapsed, stack: err.stack },
        });
        await flushErrors(cronJob);
        throw err;
      }
    })();

    const result = await Promise.race([handlerPromise, timeoutPromise]);

    if (result === TIMED_OUT) {
      const elapsed = Date.now() - start;
      logFetchError(cronJob, {
        url: null,
        message: `Timeout: still running after ${(elapsed / 1000).toFixed(1)}s (limit: ${(limitMs / 1000).toFixed(0)}s)`,
        extra: { elapsedMs: elapsed, limitMs },
      });
      console.error(`[${cronJob}] TIMEOUT after ${(elapsed / 1000).toFixed(1)}s`);
      await flushErrors(cronJob);

      // Kill the process so the zombie handler doesn't keep running
      setTimeout(() => process.exit(0), 500);

      return new Response(`[${cronJob}] timed out`, { status: 200 });
    }

    return result;
  };
}
