// DISPOSABLE, ONE-OFF WRITE endpoint — 2026-09-04.
//
// Purpose: add 6 user-approved job_filters denylist words found via the
// last-30-days uncategorized-postings audit (mostly wherewework, which is
// deliberately un-scoped by industry — see cron_jobs_DIAK_3-background.mjs).
// All non-IT, multi-word phrases chosen to avoid any collision risk.
//
// Idempotent (skips words already present). Delete this file after use.

import { Pool } from "pg";

const TOKEN = "a3e7c1f9b5d02684f7a1c9e3b6d80f5a2c7e9b1d";
const pool = new Pool({ connectionString: process.env.NETLIFY_DATABASE_URL, ssl: { rejectUnauthorized: false } });

const WORDS_TO_ADD = [
  "query resolution",
  "loyalty program",
  "planogram specialist",
  "zamestnanec prodejny",
  "handymen",
  "linguistic projects",
];

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) {
    return new Response("unauthorized", { status: 401 });
  }

  const client = await pool.connect();
  try {
    const { rows: existingRows } = await client.query(`SELECT word FROM job_filters`);
    const existing = new Set(existingRows.map((r) => r.word.toLowerCase()));

    const added = [];
    const skipped = [];
    for (const word of WORDS_TO_ADD) {
      if (existing.has(word.toLowerCase())) {
        skipped.push(word);
        continue;
      }
      await client.query(`INSERT INTO job_filters (word) VALUES ($1)`, [word]);
      added.push(word);
    }

    return new Response(JSON.stringify({ added, skipped }, null, 2), {
      headers: { "content-type": "application/json" },
    });
  } finally {
    client.release();
  }
};
