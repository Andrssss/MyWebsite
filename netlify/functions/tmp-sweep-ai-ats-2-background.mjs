// DISPOSABLE — 2026-09-15. Re-run of the scoped ai-scraped/ats-crawl sweep
// (same as the earlier tmp-sweep-ai-ats-background.mjs, already removed) after
// fixing the two coverage gaps in _ai_liveness.mjs (lejart-allashirdetes
// generalization + telekom.hu probe). Delete after use.
import { Pool } from "pg";
import { getStore } from "@netlify/blobs";
import { withTimeout } from "./_error-logger.mjs";
import { sweepActive404 } from "./_active_core.mjs";
import { fetchFinal } from "./cron_404sweep-background.mjs";

const TOKEN = "d4c8f1a02e9b736051f4c8a9e2d61b7f038a5c9e";
const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

const _runJob = withTimeout("tmp-sweep-ai-ats-2-background", async () => {
  const store = getStore("tmp-sweep-result-2");
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
