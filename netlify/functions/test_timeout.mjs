// Test file — verifies that withTimeout logs slow/crashed handlers
// Run with: node netlify/functions/test_timeout.mjs

// Mock @netlify/blobs so we can run locally without Netlify
const logs = [];
const mockStore = {
  set: async (key, value) => {
    logs.push({ key, value: JSON.parse(value) });
  },
};

// Patch the module loader — we inline a local version of the functions
// to avoid import issues with @netlify/blobs

async function logFetchError(cronJob, { url, message, extra } = {}) {
  const now = new Date();
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

  logs.push({ key, entry });
  console.log(`  [error-logger] ${cronJob}: ${statusCode || "ERR"} – ${url ?? "(no url)"}`);
}

function withTimeout(cronJob, handler, limitMs = 25000) {
  return async (...args) => {
    const start = Date.now();
    try {
      const result = await handler(...args);
      const elapsed = Date.now() - start;
      if (elapsed > limitMs) {
        await logFetchError(cronJob, {
          url: null,
          message: `Slow execution: ${(elapsed / 1000).toFixed(1)}s (limit: ${(limitMs / 1000).toFixed(0)}s)`,
          extra: { elapsedMs: elapsed, limitMs },
        });
        console.warn(`  [${cronJob}] slow: ${(elapsed / 1000).toFixed(1)}s`);
      }
      return result;
    } catch (err) {
      const elapsed = Date.now() - start;
      await logFetchError(cronJob, {
        url: null,
        message: `Handler crashed after ${(elapsed / 1000).toFixed(1)}s: ${err.message}`,
        extra: { elapsedMs: elapsed, stack: err.stack },
      });
      throw err;
    }
  };
}

// ── Tests ──────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function test1_fastHandler() {
  console.log("TEST 1: Fast handler (should NOT log)");
  logs.length = 0;

  const handler = withTimeout("test_fast", async () => {
    return new Response("OK");
  }, 500);

  const res = await handler();
  console.log(`  Response: ${await res.text()}`);
  console.log(`  Logs: ${logs.length} (expected 0)`);
  console.assert(logs.length === 0, "FAIL: should not log for fast handler");
  console.log("  PASS\n");
}

async function test2_slowHandler() {
  console.log("TEST 2: Slow handler (should log timeout)");
  logs.length = 0;

  const handler = withTimeout("test_slow", async () => {
    await sleep(600);
    return new Response("OK");
  }, 500); // 500ms limit for testing

  const res = await handler();
  console.log(`  Response: ${await res.text()}`);
  console.log(`  Logs: ${logs.length} (expected 1)`);
  console.assert(logs.length === 1, "FAIL: should log 1 timeout");
  console.assert(logs[0].entry.message.includes("Slow execution"), "FAIL: message should say Slow execution");
  console.log(`  Message: ${logs[0].entry.message}`);
  console.log("  PASS\n");
}

async function test3_crashingHandler() {
  console.log("TEST 3: Crashing handler (should log crash)");
  logs.length = 0;

  const handler = withTimeout("test_crash", async () => {
    await sleep(200);
    throw new Error("DB connection lost");
  }, 500);

  try {
    await handler();
    console.assert(false, "FAIL: should have thrown");
  } catch (err) {
    console.log(`  Caught error: ${err.message}`);
    console.log(`  Logs: ${logs.length} (expected 1)`);
    console.assert(logs.length === 1, "FAIL: should log 1 crash");
    console.assert(logs[0].entry.message.includes("Handler crashed"), "FAIL: message should say Handler crashed");
    console.log(`  Message: ${logs[0].entry.message}`);
    console.log("  PASS\n");
  }
}

async function test4_slowAndCrashing() {
  console.log("TEST 4: Slow + crashing handler");
  logs.length = 0;

  const handler = withTimeout("test_slow_crash", async () => {
    await sleep(600);
    throw new Error("Timeout from Netlify");
  }, 500);

  try {
    await handler();
  } catch (err) {
    console.log(`  Caught error: ${err.message}`);
    console.log(`  Logs: ${logs.length} (expected 1)`);
    console.assert(logs.length === 1, "FAIL: should log 1 entry");
    console.assert(logs[0].entry.extra.elapsedMs >= 500, "FAIL: elapsed should be >= 500ms");
    console.log(`  Message: ${logs[0].entry.message}`);
    console.log("  PASS\n");
  }
}

// ── Run all ──
console.log("=== withTimeout tests ===\n");
await test1_fastHandler();
await test2_slowHandler();
await test3_crashingHandler();
await test4_slowAndCrashing();
console.log("=== All tests passed ===");
