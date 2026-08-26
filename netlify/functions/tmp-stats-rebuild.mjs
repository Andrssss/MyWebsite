// netlify/functions/tmp-stats-rebuild.mjs
//
// ELDOBHATÓ, egyszer használatos endpoint (2026-08-26): a job_daily_stats +
// job_daily_categories újraépítése nulláról a nyers hirdetésekből, miután az
// állásfigyelő kategóriái megváltoztak és a mentett statisztika elavult.
// A tényleges logika a _stats_rebuild_core.mjs-ben van (az marad); ez csak a
// futtató kapu. Használat után `git rm`-mel törlendő.
//
// Azért endpoint és nem a helyi backfill_daily_stats.mjs script: (1) az
// archivált sorok Netlify Blobs-ban vannak, amihez site-kontextus kell,
// (2) a prod DB connection string helyben nincs meg.
//
//   # 1. szárazon (nem ír semmit, csak megmutatja, mi lenne):
//   curl -s "https://bakan7.netlify.app/.netlify/functions/tmp-stats-rebuild?token=TOKEN&dry=1"
//
//   # 2. élesen, teljes előélet:
//   curl -s -X POST "https://bakan7.netlify.app/.netlify/functions/tmp-stats-rebuild?token=TOKEN"
//
//   # 3. ha a 10 mp-es függvény-limit kevés: hónaponként darabolva
//   curl -s -X POST ".../tmp-stats-rebuild?token=TOKEN&from=2026-07-01&to=2026-07-31"

import pkg from "pg";
const { Pool } = pkg;
import { loadCategories } from "./load_categories.mjs";
import { rebuildStats } from "./_stats_rebuild_core.mjs";
import { withDbAuditFlush } from "./_db_audit.js";

// Egyszer használatos, ebbe a fájlba generált token — szándékosan NEM env var
// (a CRON_SECRET maszkolt a CLI-ban), és a fájllal együtt megszűnik.
const TOKEN = "7b6126460418f15c7e97f024255a11efbe73";

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

function json(status, body) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default withDbAuditFlush("tmp_stats_rebuild", async (request) => {
  const url = new URL(request.url);
  const token =
    url.searchParams.get("token") ||
    (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (token !== TOKEN) return json(401, { error: "Unauthorized" });

  const from = url.searchParams.get("from") || undefined;
  const to = url.searchParams.get("to") || undefined;
  if ((from && !DATE_RE.test(from)) || (to && !DATE_RE.test(to))) {
    return json(400, { error: "from/to formátuma YYYY-MM-DD" });
  }

  // Írni csak POST-tal lehet; a GET mindig száraz futás, hogy egy véletlen
  // böngésző-megnyitás ne írja felül a statisztikát.
  const dryRun = request.method !== "POST" || url.searchParams.get("dry") === "1";

  const client = await pool.connect();
  try {
    const jobCategories = await loadCategories();
    const result = await rebuildStats(client, jobCategories, { from, to, dryRun });
    return json(200, {
      ok: true,
      categoriesLoaded: jobCategories.map(([name]) => name),
      ...result,
    });
  } catch (err) {
    console.error("[tmp_stats_rebuild] Error:", err);
    return json(500, { error: err.message });
  } finally {
    client.release();
  }
});
