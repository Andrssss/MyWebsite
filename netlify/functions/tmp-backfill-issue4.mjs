// netlify/functions/tmp-backfill-issue4.mjs
//
// ELDOBHATÓ, egyszer használatos endpoint (2026-09-08, GitHub issue #4).
// A muisz/zyntern/tudasdiak/workcenter forrásoknak a mai fixek ELŐTT
// beszúrt sorai technologies=NULL-lal maradtak — a cron_jobs_DIAK_1
// (muisz/zyntern/tudasdiak) és cron_jobs_WORKCENTER fájlok korábban
// egyáltalán nem próbáltak technológiát kinyerni ezekre a forrásokra
// (lásd a mai commitokat). Ez a script a most már élő kinyerő-logikát
// futtatja végig a meglévő NULL sorokon, forrásonként a saját logikájával:
//   - muisz: detail-oldal, .ContentColumn (extractTechnologies már ismeri)
//   - zyntern: description elsődlegesen, csak ha üres, detail-fetch
//     (a Vue SPA job-profile ágát extractTechnologies már ismeri)
//   - tudasdiak: detail-oldal Inertia data-page JSON-jából a leírás-mezők
//   - workcenter: a WP REST API-t hívjuk újra slug alapján (nincs tárolt
//     WP post id), content.rendered-ből
//
// Csak AKTÍV sorokra fut (user-kérés: "visszafelé feltölteni az aktívakat").
// Guardolt UPDATE (`AND technologies IS NULL`), hogy egy közben megírt sort
// ne írjon felül. Használat után `git rm`.
//
//   BASE=https://bakan7.netlify.app/.netlify/functions/tmp-backfill-issue4
//   curl -s "$BASE?token=TOKEN&action=scan"
//   # ciklusban, amíg exhausted=false, forrásonként:
//   curl -s -X POST "$BASE?token=TOKEN&action=heal&source=muisz"
//   curl -s -X POST "$BASE?token=TOKEN&action=heal&source=zyntern"
//   curl -s -X POST "$BASE?token=TOKEN&action=heal&source=tudasdiak"
//   curl -s -X POST "$BASE?token=TOKEN&action=heal&source=workcenter"

import pkg from "pg";
const { Pool } = pkg;
// Az esbuild csak egy explicit ESM-importból látja meg a @netlify/blobs-ot,
// amit a _db_audit.js CJS require-je használ (lásd tmp-lang-backfill.mjs).
import "@netlify/blobs";
import { extractTechnologies, fetchText, ensureTechnologiesColumn } from "./_experience_core.mjs";
import { withDbAuditFlush } from "./_db_audit.js";

// Egyszer használatos, ebbe a fájlba generált token — szándékosan NEM env
// var, a fájllal együtt megszűnik.
const TOKEN = "b3f81c6e4a92d0f5c8b1e7a4936d0c2f5e8a1b7c";

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

const SOURCES = ["muisz", "zyntern", "tudasdiak", "workcenter"];
const BUDGET_MS = 8000;
const FETCH_TIMEOUT_MS = 7000;

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

async function fetchMuiszTech(url) {
  const html = await withDeadline(fetchText(url), FETCH_TIMEOUT_MS, url);
  return extractTechnologies(html);
}

async function fetchZynternTech(url, description) {
  if (description) {
    const fromDesc = extractTechnologies(`<body>${description}</body>`);
    if (fromDesc) return fromDesc;
  }
  const html = await withDeadline(fetchText(url), FETCH_TIMEOUT_MS, url);
  return extractTechnologies(html);
}

async function fetchTudasdiakTech(url) {
  const html = await withDeadline(fetchText(url), FETCH_TIMEOUT_MS, url);
  const raw = html.match(/data-page="([^"]+)"/)?.[1];
  if (!raw) return null;
  const data = JSON.parse(raw.replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
  const lc = data?.props?.jobPosting?.language_content;
  if (!lc) return null;
  const parts = [lc.description, lc.tasks, lc.expectations, lc.offerings, lc.is_an_advantage]
    .filter((s) => typeof s === "string" && s);
  if (!parts.length) return null;
  return extractTechnologies(`<body>${parts.join(" ")}</body>`);
}

async function fetchWorkcenterTech(url) {
  const slug = url.match(/\/munka\/([^/]+)\/?$/)?.[1];
  if (!slug) return null;
  const apiUrl = `https://workcenter.hu/wp-json/wp/v2/job-listings?slug=${encodeURIComponent(slug)}&_fields=content`;
  const txt = await withDeadline(fetchText(apiUrl), FETCH_TIMEOUT_MS, apiUrl);
  const arr = JSON.parse(txt);
  const html = arr?.[0]?.content?.rendered;
  if (!html) return null;
  return extractTechnologies(`<body>${html}</body>`);
}

async function fetchTechFor(source, row) {
  if (source === "muisz") return fetchMuiszTech(row.url);
  if (source === "zyntern") return fetchZynternTech(row.url, row.description);
  if (source === "tudasdiak") return fetchTudasdiakTech(row.url);
  if (source === "workcenter") return fetchWorkcenterTech(row.url);
  return null;
}

async function scan(client) {
  const { rows } = await client.query(
    `SELECT source, COUNT(*)::int AS active_null_technologies
       FROM job_posts
      WHERE active = true AND technologies IS NULL AND source = ANY($1)
      GROUP BY 1 ORDER BY 1`,
    [SOURCES]
  );
  return { bySource: rows };
}

async function heal(client, source, limit, offset) {
  if (!SOURCES.includes(source)) throw new Error(`unknown source: ${source}`);

  // zyntern esetén description is kell (elsődleges, hálózat nélküli próba).
  const { rows: work } = await client.query(
    `SELECT id, url, description
       FROM job_posts
      WHERE active = true AND technologies IS NULL AND source = $1
      ORDER BY id
      LIMIT $2 OFFSET $3`,
    [source, limit, offset]
  );

  const started = Date.now();
  const samples = [];
  let processed = 0;
  let filled = 0;
  let empty = 0;
  let fetchFailed = 0;

  for (const row of work) {
    if (Date.now() - started > BUDGET_MS) break;
    processed++;

    let tech;
    try {
      tech = await fetchTechFor(source, row);
    } catch (err) {
      fetchFailed++;
      continue;
    }

    // Guardolt UPDATE: csak akkor ír, ha a sor közben nem gyógyult meg
    // máshonnan (pl. egy párhuzamosan futó másik backfill).
    const res = await client.query(
      `UPDATE job_posts SET technologies = $1 WHERE id = $2 AND technologies IS NULL`,
      [tech ?? "", row.id]
    );
    if (res.rowCount > 0) {
      if (tech) {
        filled++;
        if (samples.length < 40) samples.push({ id: row.id, url: row.url, technologies: tech });
      } else {
        empty++;
      }
    }
  }

  return {
    source,
    processed,
    filled,
    empty,
    fetchFailed,
    samples,
    nextOffset: offset + processed,
    exhausted: work.length < limit,
  };
}

export default withDbAuditFlush("tmp_backfill_issue4", async (request) => {
  const url = new URL(request.url);
  const token =
    url.searchParams.get("token") ||
    (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (token !== TOKEN) return json(401, { error: "Unauthorized" });

  const action = url.searchParams.get("action") || "scan";
  const source = url.searchParams.get("source") || "";
  const limit = Math.min(Number(url.searchParams.get("limit")) || 20, 50);
  const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);

  const client = await pool.connect();
  try {
    await ensureTechnologiesColumn(client);

    if (action === "scan") return json(200, { ok: true, ...(await scan(client)) });
    if (action === "heal") return json(200, { ok: true, ...(await heal(client, source, limit, offset)) });
    return json(400, { error: `unknown action: ${action}` });
  } catch (err) {
    console.error("[tmp_backfill_issue4]", err);
    return json(500, { error: err.message, stack: String(err.stack).split("\n").slice(0, 4) });
  } finally {
    client.release();
  }
});
