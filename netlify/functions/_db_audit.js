// Persists every real UPDATE / DELETE / upsert (INSERT ... ON CONFLICT DO
// UPDATE) that actually changed a row into a Netlify Blob — not console
// logs, so it survives past log retention and is queryable/listable later
// instead of grepped out of `netlify logs`. Silent when rowCount is 0
// (guarded no-op writes, e.g. a backfill upsert that found nothing to fill,
// stay quiet). Plain INSERT (no ON CONFLICT) is not recorded — that's the
// expected/high-volume common case, not what was asked for.
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
const { Client } = require("pg");
const { getStore } = require("@netlify/blobs");

const STORE_NAME = "db-write-audit";
let pendingWrites = [];

if (!Client.prototype.__dbAuditPatched) {
  const originalQuery = Client.prototype.query;

  const STMT_RE = /^\s*(INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?([a-zA-Z_][\w."]*)/i;

  function describe(sql) {
    if (typeof sql !== "string") return null;
    const m = STMT_RE.exec(sql);
    if (!m) return null;
    const kind = m[1].toUpperCase();
    if (kind === "INSERT" && !/ON\s+CONFLICT/i.test(sql)) return null;
    return { kind: kind === "INSERT" ? "UPSERT" : kind, table: m[2] };
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
