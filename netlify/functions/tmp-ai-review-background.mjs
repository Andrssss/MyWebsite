// DISPOSABLE — 2026-09-15. User pushed back that "2 deactivated out of 522" is
// too low ([[ai-scraped-liveness-sweep]] memory). The wired sweep rules only
// cover a handful of known ATS platforms (Greenhouse/Lever/SmartRecruiters/
// Workday/Eightfold via aiScrapedProbe, Ashby/Workable/cigpannonia/DEAD_LANDINGS/
// DEAD_PHRASES via aiScrapedIsDead) — everything else falls through fail-open.
// This re-checks EXACTLY those fallen-through rows with a DIFFERENT signal
// (title-word-hit fraction against the fetched body, the proven 08-30/09-02
// method from the same memory) instead of re-asking the same wired rule twice.
// Writes a review-queue report to the "tmp-ai-review-result" Blob; nothing is
// written to job_posts here — read-only. Delete after use.
import { Pool } from "pg";
import { getStore } from "@netlify/blobs";
import { withTimeout } from "./_error-logger.mjs";
import { aiScrapedProbe } from "./_ai_liveness.mjs";
import { fetchFinal } from "./cron_404sweep-background.mjs";

const TOKEN = "7a2f9c3e6b1d84075a9e2c6f1b8d3a4e91c65d02";
const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

const DEDICATED_HOSTS = new Set(["jobs.ashbyhq.com", "apply.workable.com", "cigpannonia.hu"]);

function stripTags(body) {
  return body
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleWords(title) {
  return [...new Set((title || "").toLowerCase().match(/[a-záéíóöőúüű]{4,}/gi) || [])];
}

const CONCURRENCY = 15;

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}

const _runJob = withTimeout("tmp-ai-review-background", async () => {
  const store = getStore("tmp-ai-review-result");
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT url, source, title, company FROM job_posts
        WHERE active = true AND source = ANY($1::text[])`,
      [["AI-scraped", "ats-crawl"]]
    );

    const fallback = rows.filter((row) => {
      if (aiScrapedProbe(row)) return false;
      let host;
      try { host = new URL(row.url).hostname.replace(/^www\./, ""); } catch { return false; }
      return !DEDICATED_HOSTS.has(host);
    });

    const checked = await mapLimit(fallback, CONCURRENCY, async (row) => {
      let res;
      try {
        res = await fetchFinal(row.url, { wantBody: true });
      } catch (err) {
        return { ...row, error: err.message };
      }
      if (!res || res.status < 200 || res.status >= 400 || typeof res.body !== "string") {
        return { ...row, status: res?.status ?? null, finalUrl: res?.finalUrl ?? null, nonVerdictHttp: true };
      }
      const words = titleWords(row.title);
      const plain = stripTags(res.body).toLowerCase();
      const hits = words.filter((w) => plain.includes(w));
      const fraction = words.length ? hits.length / words.length : 1;
      return {
        ...row,
        status: res.status,
        finalUrl: res.finalUrl,
        bodyLength: res.body.length,
        titleWordCount: words.length,
        hitFraction: Math.round(fraction * 100) / 100,
        snippet: stripTags(res.body).slice(0, 400),
      };
    });

    const reviewQueue = checked
      .filter((r) => r.nonVerdictHttp || r.error || (r.titleWordCount > 0 && r.hitFraction < 0.4))
      .sort((a, b) => (a.hitFraction ?? -1) - (b.hitFraction ?? -1));

    await store.setJSON("latest.json", {
      finishedAt: new Date().toISOString(),
      totalActive: rows.length,
      fallbackChecked: fallback.length,
      reviewQueueSize: reviewQueue.length,
      reviewQueue,
    });
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
