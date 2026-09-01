import { getStore } from "@netlify/blobs";
import { flushDbAudit } from "./_db_audit.js";

const RECOVERY_STORE_NAME = "recovery-logs";

/* ── per-run recovery queue (url-migrations / reactivations) ──────
   Collected in memory during the run and flushed into ONE Netlify Blob at the
   end — zero blob writes when nothing was recovered. A container runs one
   invocation at a time, so a module-level array is safe. */
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
 * Wrap a Netlify scheduled function handler with a timeout guard.
 * A crash or a timeout is reported to the function log (console.error) —
 * there is no separate error blob store any more. Queued recovery events and
 * DB-audit entries are flushed at the end of the run either way.
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
        await flushRecoveries(cronJob);
        await flushDbAudit(cronJob);
        return result;
      } catch (err) {
        const elapsed = Date.now() - start;
        console.error(`[${cronJob}] handler crashed after ${(elapsed / 1000).toFixed(1)}s: ${err.message}`);
        if (err.stack) console.error(err.stack);
        await flushRecoveries(cronJob);
        await flushDbAudit(cronJob);
        throw err;
      }
    })();

    const result = await Promise.race([handlerPromise, timeoutPromise]);

    if (result === TIMED_OUT) {
      const elapsed = Date.now() - start;
      console.error(`[${cronJob}] TIMEOUT after ${(elapsed / 1000).toFixed(1)}s (limit: ${(limitMs / 1000).toFixed(0)}s)`);
      await flushRecoveries(cronJob);
      await flushDbAudit(cronJob);

      // Kill the process so the zombie handler doesn't keep running
      setTimeout(() => process.exit(0), 500);

      return new Response(`[${cronJob}] timed out`, { status: 200 });
    }

    return result;
  };
}
