// netlify/functions/test_timeout.mjs
// Invoke manually: /.netlify/functions/test_timeout
// Sleeps 30s to trigger the withTimeout blob log at 25s

import { withTimeout } from "./_error-logger.mjs";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export default withTimeout("test_timeout", async () => {
  console.log(`[test_timeout] started at ${new Date().toISOString()}`);
  await sleep(30000);
  console.log(`[test_timeout] finished at ${new Date().toISOString()}`);
  return new Response("OK");
});
