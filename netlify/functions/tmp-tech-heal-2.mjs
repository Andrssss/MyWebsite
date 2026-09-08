// netlify/functions/tmp-tech-heal-2.mjs
//
// ELDOBHATÓ, egyszer használatos endpoint (2026-09-08). Backfill a
// `technologies` oszlopra a 4 forrásnál, amiknek a scraper-kódja eddig
// egyáltalán nem írt technológiákat (lásd GitHub #4):
//   - muisz      (cron_jobs_DIAK_1-background.mjs) — most már ír, kód-fix megvolt
//   - zyntern    (cron_jobs_DIAK_1-background.mjs) — most már ír, kód-fix megvolt
//   - tudasdiak  (cron_jobs_DIAK_1-background.mjs) — most már ír, kód-fix megvolt
//   - workcenter (cron_jobs_WORKCENTER-background.mjs) — most már ír, kód-fix megvolt
// A scraperek MOSTANTÓL kitöltik az ÚJ soroknál — ez az endpoint csak a
// MEGLÉVŐ, technologies=NULL sorokat gyógyítja retroaktívan, egy közös
// detail-fetch + extractTechnologies() paraddal (zyntern SPA-oldalára az
// extractTechnologies-ben már van dedikált <job-profile :data="..."> fallback,
// lásd _experience_core.mjs).
//
// Azért endpoint és nem helyi script: a prod connection string helyben nincs
// meg (a Netlify CLI mindkét DB-vart maszkolja). Használat után `git rm`
// (lásd a 2026-09-01-i tmp-tech-heal.mjs ugyanezen konvencióját).
//
//   BASE=https://bakan7.netlify.app/.netlify/functions/tmp-tech-heal-2
//
//   # 1. állapotfelmérés (semmit nem ír):
//   curl -s "$BASE?token=TOKEN&action=scan"
//
//   # 2. gyógyítás, ciklusban amíg remaining>0:
//   curl -s -X POST "$BASE?token=TOKEN&action=heal"

import pkg from "pg";
const { Pool } = pkg;
// Lásd a tmp-tech-heal.mjs azonos-célú kommentjét: az import önmagában nem
// használt, csak esbuild-nek kell explicit ESM-importként a @netlify/blobs a
// bundle-be a `_db_audit.js` CommonJS require-jéhez.
import "@netlify/blobs";
import { extractTechnologies, fetchText, ensureTechnologiesColumn } from "./_experience_core.mjs";
import { withDbAuditFlush } from "./_db_audit.js";

// Egyszer használatos, ebbe a fájlba generált token — szándékosan NEM env var
// (a CRON_SECRET maszkolt a CLI-ban), és a fájllal együtt megszűnik.
const TOKEN = "7b1f4a2e9c6d0834b5a1f7e2c9d6084a3f1e7b2c";

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

const BACKFILL_SOURCES = ["muisz", "zyntern", "tudasdiak", "workcenter"];

// Egy hívás alatt ennyi ideig dolgozunk, aztán visszaadjuk a haladást — a
// szinkron Netlify-függvény kemény 10 mp-es faláról kell időben visszalépni.
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

async function queueSize(client) {
  const { rows } = await client.query(
    `SELECT source, COUNT(*)::int AS rows
       FROM job_posts
      WHERE source = ANY($1::text[])
        AND technologies IS NULL
        AND (active OR first_seen > NOW() - INTERVAL '30 days')
      GROUP BY 1 ORDER BY 1`,
    [BACKFILL_SOURCES]
  );
  return rows;
}

async function scan(client) {
  const { rows: allRows } = await client.query(
    `SELECT source,
            COUNT(*)::int AS rows,
            COUNT(*) FILTER (WHERE technologies IS NULL)::int AS null_rows,
            COUNT(*) FILTER (WHERE active AND technologies IS NULL)::int AS null_active
       FROM job_posts
      WHERE source = ANY($1::text[])
      GROUP BY 1 ORDER BY 1`,
    [BACKFILL_SOURCES]
  );
  return { bySource: allRows, workQueue: await queueSize(client) };
}

// Csak a MEGJELENŐ sorokat gyógyítjuk (aktív VAGY 30 napnál frissebb) — a
// régi, inaktív sorokat felesleges hajtani, a frontend úgysem mutatja őket.
async function heal(client, limit, offset) {
  const { rows: work } = await client.query(
    `SELECT id, source, url FROM job_posts
      WHERE source = ANY($1::text[])
        AND technologies IS NULL
        AND (active OR first_seen > NOW() - INTERVAL '30 days')
      ORDER BY source, id LIMIT $2 OFFSET $3`,
    [BACKFILL_SOURCES, limit, offset]
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
    } catch (err) {
      fetchFailed++;
      // Nincs mit tenni, marad NULL, a következő kör (más offset-tel) újrapróbálja.
      continue;
    }

    const tech = extractTechnologies(html) ?? "";
    await client.query(`UPDATE job_posts SET technologies = $1 WHERE id = $2`, [tech, row.id]);
    updated++;
    if (samples.length < 40) samples.push({ id: row.id, source: row.source, url: row.url, to: tech });
  }

  return { processed, updated, fetchFailed, samples, remaining: await queueSize(client) };
}

export default withDbAuditFlush("tmp_tech_heal_2", async (request) => {
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
    console.error("[tmp_tech_heal_2]", err);
    return json(500, { error: err.message, stack: String(err.stack).split("\n").slice(0, 4) });
  } finally {
    client.release();
  }
});
