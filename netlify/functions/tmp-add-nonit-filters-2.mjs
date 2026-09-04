// DISPOSABLE, ONE-OFF WRITE endpoint — 2026-09-04.
//
// Purpose: add the 4 remaining user-approved job_filters denylist words from
// the last-30-days uncategorized-postings audit (see
// tmp-add-nonit-filters.mjs, already used+removed, for the first batch of 6).
//
// Idempotent (skips words already present). Delete this file after use.

import { Pool } from "pg";

const TOKEN = "f1b8d4a962e7c0351b8f4d7a2e9c6b0f3a5d8e2c";
const pool = new Pool({ connectionString: process.env.NETLIFY_DATABASE_URL, ssl: { rejectUnauthorized: false } });

const WORDS_TO_ADD = [
  "general practitioners",
  "ohs specialist",
  "adatvedelmi munkatars",
  "data protection specialist",
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
