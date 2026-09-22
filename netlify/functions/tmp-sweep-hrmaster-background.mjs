// DISPOSABLE — 2026-09-22. Real, scoped production sweepActive404 run for
// AI-scraped + ats-crawl, after the hrmaster.hu DEAD_PHRASES fix was
// confirmed live (both user-confirmed-dead rows returned dead:true via the
// real isDeadResult path). User explicitly authorized this write ("nem,
// mehet"). Real sweepActive404, not a manual UPDATE. Delete after use.
import { Pool } from "pg";
import { getStore } from "@netlify/blobs";
import { withTimeout } from "./_error-logger.mjs";
import { sweepActive404 } from "./_active_core.mjs";
import { fetchFinal } from "./cron_404sweep-background.mjs";

const TOKEN = "fe87167c4f419fd964148b083e8d3b81183d3457df747bd4";
const pool = new Pool({ connectionString: process.env.NETLIFY_DATABASE_URL, ssl: { rejectUnauthorized: false } });

const _runJob = withTimeout("tmp-sweep-hrmaster-background", async () => {
  const store = getStore("tmp-sweep-hrmaster-result");
  const client = await pool.connect();
  try {
    const rc = await sweepActive404(client, fetchFinal, { sources: ["AI-scraped", "ats-crawl"] });
    let details = [];
    if (rc.deactivatedUrls.length) {
      const { rows } = await client.query(
        `SELECT source, title, company, url FROM job_posts WHERE url = ANY($1::text[]) ORDER BY source, company`,
        [rc.deactivatedUrls]
      );
      details = rows;
    }
    await store.setJSON("latest.json", { finishedAt: new Date().toISOString(), ...rc, details });
  } catch (err) {
    await store.setJSON("latest.json", { finishedAt: new Date().toISOString(), error: err.message, stack: err.stack });
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
