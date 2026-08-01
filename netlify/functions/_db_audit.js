// Persists every real INSERT / UPDATE / DELETE that actually changed a row
// into a Netlify Blob — not console logs, so it survives past log retention
// and is queryable/listable later instead of grepped out of `netlify logs`.
// Silent when rowCount is 0 (guarded no-op writes, e.g. a backfill upsert
// that found nothing to fill, or an `ON CONFLICT DO NOTHING` that hit the
// conflict, stay quiet). `INSERT ... ON CONFLICT DO UPDATE` is labeled
// "UPSERT"; a plain INSERT (no ON CONFLICT) is labeled "INSERT" — both are
// recorded (2026-08-01: plain INSERT used to be excluded as "expected/
// high-volume", which turned out to hide most of a scraper's write volume
// when attributing a DB-activity spike — see the "DB write-audit tool" memory).
//
// Buffered in memory per invocation (same shape as _error-logger.mjs's
// pendingErrors/pendingRecoveries) and flushed as ONE blob per run, on
// purpose: a store.set() kicked off from deep inside a patched query() call
// and never awaited by the top-level handler can get silently dropped when
// the function freezes right after responding. Buffering + an explicit
// awaited flush avoids that.
//
// CommonJS on purpose (not .mjs) so both `require("./_db_audit.js")` and
// `import ... from "./_db_audit.js"` (the .mjs functions) work without any
// ESM/CJS interop risk.
//
// Wiring:
//   - Cron/background functions get this for free: withTimeout in
//     _error-logger.mjs calls flushDbAudit(cronJob) automatically.
//   - Plain HTTP handlers must opt in by wrapping their export:
//       exports.handler = withDbAuditFlush("categories", async (event) => {...});
// pg is required defensively: this module is imported by _error-logger.mjs,
// which is imported by every cron/background function for withTimeout —
// INCLUDING ones that never touch Postgres themselves (e.g. cron_scheduler.mjs,
// which only POSTs to trigger other functions). Netlify's per-function bundler
// only ships the node_modules a function's OWN import graph is found to need;
// cron_scheduler.mjs never needed 'pg' before, so it wasn't bundled for it —
// an unconditional require("pg") here crashed that function's every single
// invocation for ~23h (2026-07-30 incident) with MODULE_NOT_FOUND, silently
// taking down the entire hourly scraper grid it dispatches. If 'pg' isn't
// resolvable, this function's bundle has no Postgres client to patch anyway,
// so there's nothing lost by no-op'ing instead of crashing.
let Client = null;
try {
  ({ Client } = require("pg"));
} catch {
  Client = null;
}
const { getStore } = require("@netlify/blobs");

const STORE_NAME = "db-write-audit";
let pendingWrites = [];

if (Client && !Client.prototype.__dbAuditPatched) {
  const originalQuery = Client.prototype.query;

  const STMT_RE = /^\s*(INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?([a-zA-Z_][\w."]*)/i;

  function describe(sql) {
    if (typeof sql !== "string") return null;
    const m = STMT_RE.exec(sql);
    if (!m) return null;
    const kind = m[1].toUpperCase();
    if (kind === "INSERT") {
      return { kind: /ON\s+CONFLICT/i.test(sql) ? "UPSERT" : "INSERT", table: m[2] };
    }
    return { kind, table: m[2] };
  }

  function record(desc, sqlText, rowCount) {
    if (!rowCount) return;
    pendingWrites.push({
      time: new Date().toISOString(),
      kind: desc.kind,
      table: desc.table,
      rowCount,
      sql: sqlText.replace(/\s+/g, " ").trim().slice(0, 220),
    });
  }

  Client.prototype.query = function (...args) {
    const rawSql = typeof args[0] === "string" ? args[0] : args[0]?.text;
    const desc = describe(rawSql);

    if (!desc) {
      return originalQuery.apply(this, args);
    }

    const lastIdx = args.length - 1;
    if (typeof args[lastIdx] === "function") {
      const userCb = args[lastIdx];
      args[lastIdx] = function (err, result) {
        if (!err) record(desc, rawSql, result?.rowCount);
        return userCb.apply(this, arguments);
      };
      return originalQuery.apply(this, args);
    }

    const result = originalQuery.apply(this, args);
    if (result && typeof result.then === "function") {
      result.then((r) => record(desc, rawSql, r?.rowCount)).catch(() => {});
    }
    return result;
  };

  Client.prototype.__dbAuditPatched = true;
}

/** Flush queued writes for this invocation into ONE "db-write-audit" blob. */
async function flushDbAudit(jobName) {
  if (pendingWrites.length === 0) return;
  const writes = pendingWrites;
  pendingWrites = [];
  try {
    const store = getStore(STORE_NAME);
    const now = new Date();
    const ts = now.toISOString().replace(/[:.]/g, "-");
    const key = `${jobName || "unknown"}/${ts}.json`;
    const entry = {
      jobName: jobName || "unknown",
      date: now.toISOString(),
      writeCount: writes.length,
      writes,
    };
    await store.set(key, JSON.stringify(entry, null, 2));
    console.log(`[db-audit] ${jobName}: flushed ${writes.length} write(s) to blob`);
  } catch (err) {
    console.error(`[db-audit] flush failed: ${err.message}`);
  }
}

/** Wrap a plain HTTP handler export so its writes flush before it returns. */
function withDbAuditFlush(jobName, handler) {
  return async (...args) => {
    try {
      return await handler(...args);
    } finally {
      await flushDbAudit(jobName);
    }
  };
}

module.exports = { flushDbAudit, withDbAuditFlush };
