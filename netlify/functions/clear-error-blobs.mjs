/**
 * Manual cleanup function — deletes ALL blobs from the "fetch-error-logs" store.
 *
 * NO schedule → only runs when triggered manually via HTTP.
 *
 * Trigger:
 *   curl -X POST -H "Authorization: Bearer $CRON_SECRET" \
 *        https://<your-site>/.netlify/functions/clear-error-blobs
 *
 * Requires CRON_SECRET env var to be set in Netlify.
 */

import { getStore } from "@netlify/blobs";

const STORE_NAME = "fetch-error-logs";

export default async (request) => {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get("authorization") || "";

  if (!secret || auth !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const store = getStore(STORE_NAME);

  let deleted = 0;
  let failed = 0;
  let cursor;

  console.log(`[clear-error-blobs] listing blobs in "${STORE_NAME}"...`);

  do {
    const page = await store.list({ cursor });
    for (const { key } of page.blobs) {
      try {
        await store.delete(key);
        deleted++;
      } catch (err) {
        failed++;
        console.error(`  FAILED ${key}: ${err.message}`);
      }
    }
    cursor = page.cursor;
  } while (cursor);

  const msg = `[clear-error-blobs] done. deleted=${deleted}, failed=${failed}`;
  console.log(msg);
  return new Response(msg, { status: 200 });
};
