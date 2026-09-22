// DISPOSABLE — 2026-09-22. Real, scoped production sweepActive404 run for
// AI-scraped + ats-crawl, after the 3 liveness-rule fixes (Workable
// *.workable.com host widen, morganstanley.eightfold.ai, hrfelho.hu
// DEAD_PHRASES) were confirmed live by a read-only re-run. This one WRITES
// (user explicitly authorized it) — real sweepActive404, not a manual
// UPDATE. Delete after use.
import { Pool } from "pg";
import { getStore } from "@netlify/blobs";
import { withTimeout } from "./_error-logger.mjs";
import { sweepActive404 } from "./_active_core.mjs";
import { fetchFinal } from "./cron_404sweep-background.mjs";

const TOKEN = "f4cb89f60f5eb6dcd597d947c5d3aa55139278916d9a563e";
const pool = new Pool({ connectionString: process.env.NETLIFY_DATABASE_URL, ssl: { rejectUnauthorized: false } });

const _runJob = withTimeout("tmp-sweep-ai-ats-confirm-background", async () => {
  const store = getStore("tmp-sweep-ai-ats-confirm-result");
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
