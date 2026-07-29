// Side-effect-only module: monkey-patches pg's Client.prototype.query so
// every UPDATE / DELETE / upsert (INSERT ... ON CONFLICT DO UPDATE) that
// actually changes a row gets one console.log line — kind, table, rowCount,
// the statement itself. Silent when rowCount is 0 (guarded no-op writes,
// e.g. backfill upserts that found nothing to fill, stay quiet — only real
// mutations get logged). Plain INSERT (no ON CONFLICT) is not logged; that
// wasn't asked for and is the expected/noisy common case.
//
// CommonJS on purpose (not .mjs) so both `require("./_db_audit.js")` (the
// plain .js functions) and `import "./_db_audit.js"` (the .mjs functions)
// can pull it in for its side effect without any ESM/CJS interop risk.
//
// Patches Client.prototype directly, so both `client.query(...)` and
// `pool.query(...)` (which internally calls a real Client's query) are
// covered — no per-call-site changes needed. Idempotent across repeated
// requires/warm containers via the __dbAuditPatched guard.
const { Client } = require("pg");

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

  function logIfWritten(desc, sqlText, rowCount) {
    if (!rowCount) return;
    const snippet = sqlText.replace(/\s+/g, " ").trim().slice(0, 220);
    console.log(`[db-audit] ${desc.kind} ${desc.table} rowCount=${rowCount} :: ${snippet}`);
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
        if (!err) logIfWritten(desc, rawSql, result?.rowCount);
        return userCb.apply(this, arguments);
      };
      return originalQuery.apply(this, args);
    }

    const result = originalQuery.apply(this, args);
    if (result && typeof result.then === "function") {
      result.then((r) => logIfWritten(desc, rawSql, r?.rowCount)).catch(() => {});
    }
    return result;
  };

  Client.prototype.__dbAuditPatched = true;
}
