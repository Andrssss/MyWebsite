#!/usr/bin/env node
/**
 * Manual cleanup script — deletes ALL blobs from the "fetch-error-logs" store.
 *
 * Run with:
 *   node scripts/clear-error-blobs.mjs
 *
 * Required env vars:
 *   NETLIFY_SITE_ID     — your Netlify site ID
 *   NETLIFY_AUTH_TOKEN  — a Netlify personal access token
 *
 * (Both are available in the Netlify UI: User settings → Applications → Personal access tokens
 *  and Site settings → General → Site information → Site ID.)
 */

import { getStore } from "@netlify/blobs";

const STORE_NAME = "fetch-error-logs";

const siteID = process.env.NETLIFY_SITE_ID;
const token = process.env.NETLIFY_AUTH_TOKEN;

if (!siteID || !token) {
  console.error("ERROR: NETLIFY_SITE_ID and NETLIFY_AUTH_TOKEN env vars must be set.");
  process.exit(1);
}

const store = getStore({ name: STORE_NAME, siteID, token });

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
      if (deleted % 50 === 0) console.log(`  deleted ${deleted}...`);
    } catch (err) {
      failed++;
      console.error(`  FAILED ${key}: ${err.message}`);
    }
  }
  cursor = page.cursor;
} while (cursor);

console.log(`[clear-error-blobs] done. deleted=${deleted}, failed=${failed}`);
