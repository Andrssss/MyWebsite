// DISPOSABLE — 2026-09-15. Backfills job_posts.technologies for LIVE
// nofluffjobs rows whose posting requires a language (ISO code in the
// posting's own embedded requirements.languages, e.g. "pl" = Polish) that
// isn't reflected in the stored technologies string — root cause: this
// structured field was ignored by the scraper until the same-day fix in
// cron_jobs_NOFLUFFJOBS-background.mjs (see NFJ_LANGUAGE_LABELS there).
// Re-derives technologies via the SAME extraction the fixed scraper now
// uses, then UNIONS it with whatever is already stored (never drops an
// existing label, only adds). Only rows whose page is still live can be
// re-fetched at all, hence `active = true`.
// Writes a report to the "tmp-nfj-polish-backfill-result" Blob. Delete
// this file and its -result.mjs sibling after use.
import { Pool } from "pg";
import { load as cheerioLoad } from "cheerio";
import { getStore } from "@netlify/blobs";
import { withTimeout } from "./_error-logger.mjs";
import { extractTechnologies } from "./_experience_core.mjs";

const TOKEN = "b4e7f1a9c2d6083f5b7e1a9c4d8f2b6e0a3c7d15";
const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

const NGSTATE_UNESCAPE = { "&a;": "&", "&q;": '"', "&s;": "'", "&l;": "<", "&g;": ">" };

const NFJ_LANGUAGE_LABELS = {
  hu: "Hungarian", en: "English", de: "German", fr: "French", it: "Italian",
  es: "Spanish", nl: "Dutch", ru: "Russian", ro: "Romanian", sk: "Slovak",
  cs: "Czech", sr: "Serbian", hr: "Croatian", sl: "Slovenian", bg: "Bulgarian",
  uk: "Ukrainian", pt: "Portuguese", sv: "Swedish", no: "Norwegian", da: "Danish",
  fi: "Finnish", el: "Greek", tr: "Turkish", ar: "Arabic", zh: "Chinese",
  ja: "Japanese", ko: "Korean", he: "Hebrew", pl: "Polish",
};

function extractPostingState(html) {
  try {
    const $ = cheerioLoad(html);
    const raw = $("#serverApp-state").html() || $("#serverApp-state").text();
    if (!raw) return null;
    const json = raw.replace(/&[aqslg];/g, (m) => NGSTATE_UNESCAPE[m] ?? m);
    const state = JSON.parse(json);
    const key = Object.keys(state).find((k) => k.startsWith("/posting/"));
    return key ? state[key] : null;
  } catch {
    return null;
  }
}

function recomputeTechnologies(html) {
  const posting = extractPostingState(html);
  if (!posting) return null;
  const req = posting.requirements || {};
  const parts = [];
  for (const list of [req.musts, req.nices]) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const value = typeof entry === "string" ? entry : entry?.value;
      if (value) parts.push(`<li>${value}</li>`);
    }
  }
  if (typeof req.description === "string" && req.description) parts.push(req.description);
  if (Array.isArray(posting.specs?.dailyTasks)) {
    for (const task of posting.specs.dailyTasks) {
      if (typeof task === "string" && task) parts.push(`<li>${task}</li>`);
    }
  }
  const found = new Set();
  if (parts.length) {
    const text = extractTechnologies(`<div class="description">${parts.join(" ")}</div>`);
    if (text) for (const label of text.split(", ")) found.add(label);
  }
  if (Array.isArray(req.languages)) {
    for (const entry of req.languages) {
      const label = NFJ_LANGUAGE_LABELS[entry?.code];
      if (label) found.add(label);
    }
  }
  return found.size ? [...found].join(", ") : null;
}

const CONCURRENCY = 8;

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

const _runJob = withTimeout("tmp-nfj-polish-backfill-background", async () => {
  const store = getStore("tmp-nfj-polish-backfill-result");
  const client = await pool.connect();
  let rows;
  try {
    ({ rows } = await client.query(
      `SELECT id, url, title, technologies FROM job_posts
        WHERE source = 'nofluffjobs' AND active = true`
    ));
  } finally {
    client.release();
  }

  const changed = [];
  const errors = [];
  let fetchFailed = 0;
  let unchanged = 0;

  await mapLimit(rows, CONCURRENCY, async (row) => {
    let html;
    try {
      const res = await fetch(row.url, {
        headers: {
          "User-Agent": "JobWatcher/1.0",
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "hu-HU,hu;q=0.9,en;q=0.8",
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      html = await res.text();
    } catch (err) {
      fetchFailed++;
      errors.push({ url: row.url, error: String(err?.message || err) });
      return;
    }

    let recomputed;
    try {
      recomputed = recomputeTechnologies(html);
    } catch (err) {
      errors.push({ url: row.url, error: `extract: ${String(err?.message || err)}` });
      return;
    }
    if (!recomputed) {
      unchanged++;
      return;
    }

    const before = row.technologies || "";
    const beforeSet = new Set(before ? before.split(", ") : []);
    const merged = new Set(beforeSet);
    for (const label of recomputed.split(", ")) merged.add(label);
    const after = [...merged].join(", ");

    if (after === before) {
      unchanged++;
      return;
    }

    try {
      const client2 = await pool.connect();
      try {
        await client2.query(`UPDATE job_posts SET technologies = $1 WHERE id = $2`, [after, row.id]);
      } finally {
        client2.release();
      }
      changed.push({ url: row.url, title: row.title, before, after });
    } catch (err) {
      errors.push({ url: row.url, error: `update: ${String(err?.message || err)}` });
    }
  });

  const report = {
    finishedAt: new Date().toISOString(),
    totalRows: rows.length,
    changedCount: changed.length,
    unchangedCount: unchanged,
    fetchFailedCount: fetchFailed,
    errorCount: errors.length,
    changed,
    errors,
  };
  await store.setJSON("latest.json", report);
});

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });
  _runJob();
  return new Response("started", { status: 202 });
};
