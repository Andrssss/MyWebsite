// netlify/functions/tmp-lang-backfill.mjs
//
// ELDOBHATÓ, egyszer használatos endpoint (2026-09-08). A `_tech_keywords.js`-be
// most bekerült nyelv-kulcsszavak (Hungarian/English/German/…) csak az EZUTÁN
// beszúrt sorokra hatnak — a technologies extractionnek nincs raw-text tárolása
// a job_posts-ban (csak a KÉSZ technologies string), tehát a régi aktív sorokat
// csak élő oldal-újralekéréssel lehet frissíteni. Ugyanaz a minta, mint a
// tmp-tech-heal.mjs (2026-09-01) — annak a scriptnek a heal()-jét másolja,
// de ADDITÍV: sosem töröl/cserél meglévő címkét, csak a frissen felismert
// (ténylegesen csak a nyelv-) címkéket UNION-olja hozzá.
//
// Kihagyva (ugyanazért, mint tmp-tech-heal-ben):
//   • LinkedIn — anti-bot/login-wall, egy hibás válasz semmit nem bizonyít,
//     és amúgy is időablakos a frontenden.
//   • AI-scraped — a technologies ott az LLM saját listájából jön
//     (normalizeTechnologyList), nem oldal-body-ból; nincs mit újrafetchelni.
//
// Használat után `git rm`.
//
//   BASE=https://bakan7.netlify.app/.netlify/functions/tmp-lang-backfill
//
//   # 1. állapotfelmérés (semmit nem ír):
//   curl -s "$BASE?token=TOKEN&action=scan"
//
//   # 2. ciklusban, amíg remaining>0:
//   curl -s -X POST "$BASE?token=TOKEN&action=heal"

import pkg from "pg";
const { Pool } = pkg;
// L. tmp-tech-heal.mjs fejléce: az esbuild csak egy explicit ESM-importból
// látja meg a @netlify/blobs-ot, amit a _db_audit.js CJS require-je használ.
import "@netlify/blobs";
import { extractTechnologies, fetchText, ensureTechnologiesColumn } from "./_experience_core.mjs";
import { withDbAuditFlush } from "./_db_audit.js";

// Egyszer használatos, ebbe a fájlba generált token — szándékosan NEM env var,
// a fájllal együtt megszűnik.
const TOKEN = "7f1b4c9e3a6d0852f7c4e91b3a08d6f2c5e7";

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

const EXCLUDED_SOURCES = ["LinkedIn", "AI-scraped"];

const BUDGET_MS = 7500;
const FETCH_TIMEOUT_MS = 6000;

function json(status, body) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function withDeadline(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout ${label}`)), ms)),
  ]);
}

function splitLabels(value) {
  return String(value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Csak HOZZÁAD: a friss extractTechnologies() eredményéből mindent megtart,
// ami eddig NEM volt ott, a meglévő sorrendet és tartalmat érintetlenül
// hagyja. Visszaad `null`-t, ha nincs új címke (semmit nem kell írni).
function mergeAdditive(existingStr, freshStr) {
  const existing = splitLabels(existingStr);
  const existingSet = new Set(existing);
  const added = splitLabels(freshStr).filter((l) => !existingSet.has(l));
  if (!added.length) return null;
  return [...existing, ...added].join(", ");
}

const SQL_WORK = `
  SELECT id, source, url, technologies
    FROM job_posts
   WHERE active = true
     AND source NOT IN (${EXCLUDED_SOURCES.map((_, i) => `$${i + 1}`).join(", ")})
   ORDER BY id`;

async function scan(client) {
  const { rows: bySource } = await client.query(
    `SELECT source, COUNT(*)::int AS active_rows
       FROM job_posts
      WHERE active = true
      GROUP BY 1 ORDER BY 2 DESC`
  );
  const { rows: totalRows } = await client.query(`SELECT COUNT(*)::int AS n FROM (${SQL_WORK}) q`, EXCLUDED_SOURCES);
  return { queueTotal: totalRows[0].n, excludedSources: EXCLUDED_SOURCES, activeBySource: bySource };
}

async function heal(client, limit, offset) {
  const { rows: work } = await client.query(
    `${SQL_WORK} LIMIT $${EXCLUDED_SOURCES.length + 1} OFFSET $${EXCLUDED_SOURCES.length + 2}`,
    [...EXCLUDED_SOURCES, limit, offset]
  );

  const started = Date.now();
  const samples = [];
  let processed = 0;
  let updated = 0;
  let fetchFailed = 0;

  for (const row of work) {
    if (Date.now() - started > BUDGET_MS) break;
    processed++;

    let html;
    try {
      html = await withDeadline(fetchText(row.url), FETCH_TIMEOUT_MS, row.url);
    } catch {
      fetchFailed++;
      continue; // tranziens vagy végleges — itt mindegy, additív, nem kell dönteni: legközelebb újra próbáljuk
    }

    const fresh = extractTechnologies(html);
    const merged = mergeAdditive(row.technologies, fresh);
    if (merged) {
      await client.query(`UPDATE job_posts SET technologies = $1 WHERE id = $2`, [merged, row.id]);
      updated++;
      if (samples.length < 40) samples.push({ id: row.id, source: row.source, from: row.technologies, to: merged });
    }
  }

  return {
    processed,
    updated,
    fetchFailed,
    samples,
    nextOffset: offset + processed,
    exhausted: work.length < limit, // a tábla végére értünk ezzel a lapozással
  };
}

export default withDbAuditFlush("tmp_lang_backfill", async (request) => {
  const url = new URL(request.url);
  const token =
    url.searchParams.get("token") ||
    (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (token !== TOKEN) return json(401, { error: "Unauthorized" });

  const action = url.searchParams.get("action") || "scan";
  const limit = Math.min(Number(url.searchParams.get("limit")) || 25, 100);
  const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);

  const client = await pool.connect();
  try {
    await ensureTechnologiesColumn(client);

    if (action === "scan") return json(200, { ok: true, ...(await scan(client)) });
    if (action === "heal") return json(200, { ok: true, ...(await heal(client, limit, offset)) });
    return json(400, { error: `unknown action: ${action}` });
  } catch (err) {
    console.error("[tmp_lang_backfill]", err);
    return json(500, { error: err.message, stack: String(err.stack).split("\n").slice(0, 4) });
  } finally {
    client.release();
  }
});
