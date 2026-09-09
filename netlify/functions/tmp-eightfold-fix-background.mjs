// DISPOSABLE apply endpoint — 2026-09-09. Applies the new Eightfold
// sitemap-based liveness rule (_ai_liveness.mjs) to every currently-active
// AI-scraped + ats-crawl row hosted on a known Eightfold tenant, in both
// directions: deactivates confirmed-dead rows, reactivates any inactive row
// that's actually back on the tenant's open-postings sitemap. Double-checked
// (two independent fetches of the tenant sitemap, a few seconds apart) before
// acting on either direction, per the transient-blip lesson from the earlier
// audit this same day. Delete after use.

import { Pool } from "pg";
import https from "https";
import { getStore } from "@netlify/blobs";
import { aiScrapedProbe, aiScrapedIsDead } from "./_ai_liveness.mjs";

const TOKEN = "9f2c7a41e6b830d5f174c2a90b6e83d1a5c7e02f9b41d637";
const connectionString = process.env.NETLIFY_DATABASE_URL;
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

const EIGHTFOLD_HOSTS = ["jobs.ericsson.com", "jobs.vodafone.com"];

function fetchBody(url) {
  return new Promise((resolve) => {
    https.get(url, {
      headers: { "User-Agent": "Mozilla/5.0", "Accept-Encoding": "identity" },
      timeout: 20000,
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode, body, finalUrl: url }));
    }).on("error", () => resolve({ status: -3, body: "", finalUrl: url }))
      .on("timeout", function () { this.destroy(); resolve({ status: -2, body: "", finalUrl: url }); });
  });
}

async function run() {
  const client = await pool.connect();
  const report = { deactivated: [], reactivated: [], checked: 0, sitemapSizes: {} };
  try {
    const hostPatterns = EIGHTFOLD_HOSTS.map((h) => `%${h}%`);
    const { rows } = await client.query(
      `SELECT id, url, source, active FROM job_posts
        WHERE source IN ('AI-scraped', 'ats-crawl')
          AND (${hostPatterns.map((_, i) => `url LIKE $${i + 1}`).join(" OR ")})`,
      hostPatterns
    );
    report.checked = rows.length;

    // Pre-fetch each tenant's sitemap TWICE (a beat apart) so a row is only
    // acted on if both independent fetches agree.
    const sitemaps = {};
    for (const host of EIGHTFOLD_HOSTS) {
      const url = `https://${host}/careers/sitemap.xml`;
      const first = await fetchBody(url);
      await new Promise((r) => setTimeout(r, 2000));
      const second = await fetchBody(url);
      sitemaps[host] = { first, second };
      report.sitemapSizes[host] = { firstLen: first.body.length, secondLen: second.body.length, status1: first.status, status2: second.status };
    }

    for (const row of rows) {
      let host;
      try { host = new URL(row.url).hostname.replace(/^www\./, ""); } catch { continue; }
      if (!EIGHTFOLD_HOSTS.includes(host)) continue;
      const sm = sitemaps[host];
      if (!sm || sm.first.status !== 200 || sm.second.status !== 200) continue; // no verdict

      const probe = aiScrapedProbe(row);
      if (!probe) continue;
      const deadFirst = aiScrapedIsDead(row, sm.first.body, { status: 200, finalUrl: probe.url });
      const deadSecond = aiScrapedIsDead(row, sm.second.body, { status: 200, finalUrl: probe.url });

      if (row.active && deadFirst && deadSecond) {
        report.deactivated.push({ id: row.id, url: row.url, source: row.source });
      } else if (!row.active && !deadFirst && !deadSecond) {
        report.reactivated.push({ id: row.id, url: row.url, source: row.source });
      }
    }

    if (report.deactivated.length) {
      await client.query(
        `UPDATE job_posts SET active = false, sweep_dead = true WHERE id = ANY($1::int[])`,
        [report.deactivated.map((r) => r.id)]
      );
    }
    if (report.reactivated.length) {
      await client.query(
        `UPDATE job_posts SET active = true, sweep_dead = false WHERE id = ANY($1::int[])`,
        [report.reactivated.map((r) => r.id)]
      );
    }
  } finally {
    client.release();
  }

  await getStore({ name: "tmp-ai-audit", consistency: "strong" }).setJSON("eightfold-report.json", {
    generatedAt: new Date().toISOString(),
    ...report,
  });
  console.log("[tmp-eightfold-fix] " + JSON.stringify({ checked: report.checked, deactivated: report.deactivated.length, reactivated: report.reactivated.length }));
}

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });
  await run();
  return new Response("OK");
};
