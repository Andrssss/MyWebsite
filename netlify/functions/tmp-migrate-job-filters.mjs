// netlify/functions/tmp-migrate-job-filters.mjs
//
// ELDOBHATÓ, egyszer használatos endpoint (2026-09-09). Átmásolja a Postgres
// `job_filters` tábla teljes tartalmát (id, word) a "job-filters" Blob-ba
// (_job_filters_store.mjs), amit a most átírt filters.mjs + load_filters.mjs
// mostantól használ. A Postgres táblát NEM törli — csak olvas belőle; a
// tábla a szokásos óvatosságból egyelőre a helyén marad (l. CLAUDE.md).
//
// Használat után `git rm`.
//
//   # állapotfelmérés, semmit nem ír:
//   curl -s "https://bakan7.netlify.app/.netlify/functions/tmp-migrate-job-filters?token=TOKEN&dryRun=1"
//
//   # tényleges migráció:
//   curl -s "https://bakan7.netlify.app/.netlify/functions/tmp-migrate-job-filters?token=TOKEN"

import { Pool } from "pg";
import { readFilterState, writeFilterState } from "./_job_filters_store.mjs";

// Egyszer használatos, ebbe a fájlba generált token — szándékosan NEM env
// var, a fájllal együtt megszűnik.
const TOKEN = "39df8b7dc9294abebc646ca6f35cea62583d5aeda0c0a6ee";

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

function json(status, body) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export default async (request) => {
  const url = new URL(request.url);
  const token =
    url.searchParams.get("token") ||
    (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (token !== TOKEN) return json(401, { error: "Unauthorized" });

  const dryRun = url.searchParams.get("dryRun") === "1";

  const client = await pool.connect();
  let pgRows;
  try {
    const { rows } = await client.query(`SELECT id, word FROM job_filters ORDER BY id`);
    pgRows = rows;
  } finally {
    client.release();
  }

  const existing = await readFilterState();
  const maxId = pgRows.reduce((m, r) => Math.max(m, r.id), 0);

  if (dryRun) {
    return json(200, {
      ok: true,
      dryRun: true,
      pgCount: pgRows.length,
      existingBlobCount: existing.words.length,
      maxId,
      sample: pgRows.slice(0, 5),
    });
  }

  const state = { nextId: maxId + 1, words: pgRows.map((r) => ({ id: r.id, word: r.word })) };
  await writeFilterState(state);

  return json(200, {
    ok: true,
    migratedCount: state.words.length,
    nextId: state.nextId,
    previousBlobCount: existing.words.length,
  });
};
