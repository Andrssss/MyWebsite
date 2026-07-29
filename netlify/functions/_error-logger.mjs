import { getStore } from "@netlify/blobs";
import "./_db_audit.js";

const STORE_NAME = "fetch-error-logs";
const RECOVERY_STORE_NAME = "recovery-logs";

/* ── per-run error queue (flushed automatically by withTimeout) ── */
const pendingErrors = new Map();

/* ── per-run recovery queue (url-migrations / reactivations) ──────
   Same lifecycle as pendingErrors: collected in memory during the run and
   flushed into ONE Netlify Blob at the end — zero blob writes when nothing
   was recovered. A container runs one invocation at a time, so a module-level
   array is safe. */
const pendingRecoveries = [];

/**
 * Queue a recovery event (a DB write that healed state rather than ingesting):
 *   { type: "url-migrated",  source, from, to }
 *   { type: "reactivated",   source, count, urls }
 * Flushed by withTimeout (or an explicit flushRecoveries call) into the
 * "recovery-logs" blob store so DB-side healing stays auditable without any
 * extra DB writes.
 */
export function logRecovery(event) {
  pendingRecoveries.push({ ...event, time: new Date().toISOString() });
  console.log(`[recovery-logger] queued ${event.type} [${event.source}]`);
}

/** Flush queued recovery events into one "recovery-logs" blob for this run. */
export async function flushRecoveries(cronJob) {
  if (pendingRecoveries.length === 0) return;
  try {
    const store = getStore(RECOVERY_STORE_NAME);
    const now = new Date();
    const ts = now.toISOString().replace(/[:.]/g, "-");
    const key = `${cronJob}/${ts}.json`;

    const entry = {
      cronJob,
      date: now.toISOString(),
      eventCount: pendingRecoveries.length,
      events: pendingRecoveries.slice(),
    };

    await store.set(key, JSON.stringify(entry, null, 2));
    console.log(`[recovery-logger] ${cronJob}: flushed ${entry.eventCount} recovery event(s)`);
    pendingRecoveries.length = 0;
  } catch (logErr) {
    console.error(`[recovery-logger] flush failed: ${logErr.message}`);
  }
}

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
 * @param {number} [limitMs] – timeout threshold in ms.
 *   Defaults to 29s for normal scheduled functions and 14 min for
 *   background functions (cronJob name ending in "-background").
 * @returns {Function} wrapped handler
 */
export function withTimeout(cronJob, handler, limitMs) {
  if (limitMs == null) {
    limitMs = cronJob.endsWith("-background") ? 14 * 60 * 1000 : 29000;
  }
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
        await flushRecoveries(cronJob);
        return result;
      } catch (err) {
        const elapsed = Date.now() - start;
        logFetchError(cronJob, {
          url: null,
          message: `Handler crashed after ${(elapsed / 1000).toFixed(1)}s: ${err.message}`,
          extra: { elapsedMs: elapsed, stack: err.stack },
        });
        await flushErrors(cronJob);
        await flushRecoveries(cronJob);
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
      await flushRecoveries(cronJob);

      // Kill the process so the zombie handler doesn't keep running
      setTimeout(() => process.exit(0), 500);

      return new Response(`[${cronJob}] timed out`, { status: 200 });
    }

    return result;
  };
}
