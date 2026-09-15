// DISPOSABLE — 2026-09-15. Scoped re-run of the liveness sweep for just the
// AI-scraped source, to confirm/apply the 8 user-reported false-active rows
// (and any other AI-scraped row the naih.hu/lechnerkozpont.hu/trskarrier.hu
// fixes now newly cover) through the real production path. Delete after use.
import { Pool } from "pg";
import { getStore } from "@netlify/blobs";
import { withTimeout } from "./_error-logger.mjs";
import { sweepActive404 } from "./_active_core.mjs";
import { fetchFinal } from "./cron_404sweep-background.mjs";

const TOKEN = "8e5cd1792cf8c063feaf48c3146e3aa494d7cab693744fb7";
const pool = new Pool({ connectionString: process.env.NETLIFY_DATABASE_URL, ssl: { rejectUnauthorized: false } });

const _runJob = withTimeout("tmp-sweep-aiscraped-background", async () => {
  const store = getStore("tmp-sweep-aiscraped-result");
  const client = await pool.connect();
  try {
    const rc = await sweepActive404(client, fetchFinal, { sources: ["AI-scraped"] });
    let details = [];
    if (rc.deactivatedUrls.length) {
      const { rows } = await client.query(
        `SELECT source, title, company, url FROM job_posts WHERE url = ANY($1::text[]) ORDER BY company`,
        [rc.deactivatedUrls]
      );
      details = rows;
    }
    await store.setJSON("latest.json", { finishedAt: new Date().toISOString(), ...rc, details });
  } catch (err) {
    await store.setJSON("latest.json", { finishedAt: new Date().toISOString(), error: err.message });
  } finally {
    client.release();
  }
  return new Response("OK");
});

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });
  return _runJob(request);
};
