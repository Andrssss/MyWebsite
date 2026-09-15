// DISPOSABLE — 2026-09-15. One-off manual re-run of the daily 404-sweep's
// liveness rules (_active_core.mjs / _ai_liveness.mjs), scoped to just the
// "AI-scraped" and "ats-crawl" sources, on user request ("go through their
// active postings and deactivate the clearly-expired ones now" rather than
// waiting for the scheduled pass). Reuses sweepActive404 + fetchFinal
// verbatim — no re-implementation of the per-platform dead rules.
// Background function ⇒ no response body reaches the caller; the result is
// written to the "tmp-sweep-result" Blob and read back via tmp-sweep-result.mjs.
// Delete both files (and the Blob store, if it matters) after use.
import { Pool } from "pg";
import { getStore } from "@netlify/blobs";
import { withTimeout } from "./_error-logger.mjs";
import { sweepActive404 } from "./_active_core.mjs";
import { fetchFinal } from "./cron_404sweep-background.mjs";

const TOKEN = "11286b20c897f7d8315b26e2de95fe65a211f7ea991cb7c4";
const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

const _runJob = withTimeout("tmp-sweep-ai-ats-background", async () => {
  const store = getStore("tmp-sweep-result");
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
    await store.setJSON("latest.json", {
      finishedAt: new Date().toISOString(),
      checked: rc.checked,
      suspects: rc.suspects,
      deactivated: rc.deactivated,
      details,
    });
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
