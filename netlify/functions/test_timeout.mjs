// netlify/functions/test_timeout.mjs
// A test cron job that sleeps 40s to verify withTimeout logging

// import { withTimeout } from "./_error-logger.mjs";

// export const config = {
//   schedule: "0 0 31 2 *", // never runs automatically (Feb 31)
// };

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export default withTimeout("test_timeout", async () => {
  console.log(`[test_timeout] started at ${new Date().toISOString()}`);
  await sleep(40000);
  console.log(`[test_timeout] finished at ${new Date().toISOString()}`);
  return new Response("OK");
});
