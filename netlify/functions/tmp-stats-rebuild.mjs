// netlify/functions/tmp-stats-rebuild.mjs
//
// ELDOBHATÓ, egyszer használatos endpoint (2026-09-01): a job_daily_stats +
// job_daily_categories újraépítése NULLÁRÓL a nyers hirdetésekből — élő
// job_posts + a "job-posts-archive" blobok. A tényleges logika a
// _stats_rebuild_core.mjs-ben van (az marad); ez csak a futtató kapu.
// Használat után `git rm`-mel törlendő.
//
// Azért endpoint és nem helyi script: (1) az archivált sorok Netlify
// Blobs-ban vannak, amihez site-kontextus kell, (2) a prod DB connection
// string helyben nincs meg.
//
//   # 1. állapotfelmérés (mely archívum-blobok vannak fent, mit fed le a stats):
//   curl -s ".../tmp-stats-rebuild?token=TOKEN&action=status"
//
//   # 2. hiányzó archívum feltöltése a repo scripts/job_archive mappájából:
//   curl -s -X POST --data-binary @scripts/job_archive/FILE.txt \
//        -H "Content-Type: application/json" \
//        ".../tmp-stats-rebuild?token=TOKEN&action=upload&key=job-posts-archive-....json"
//
//   # 3. szárazon (nem ír semmit):
//   curl -s ".../tmp-stats-rebuild?token=TOKEN&action=rebuild&dry=1"
//
//   # 4. élesen, teljes előélet (vagy hónaponként darabolva from/to-val):
//   curl -s -X POST ".../tmp-stats-rebuild?token=TOKEN&action=rebuild"

import { getStore } from "@netlify/blobs";
import pkg from "pg";
const { Pool } = pkg;
import { loadCategories } from "./load_categories.mjs";
import { rebuildStats, loadArchiveRows } from "./_stats_rebuild_core.mjs";
import { withDbAuditFlush } from "./_db_audit.js";

// Egyszer használatos, ebbe a fájlba generált token — szándékosan NEM env var
// (a CRON_SECRET maszkolt a CLI-ban), és a fájllal együtt megszűnik.
const TOKEN = "418487805c87f1fd2c070e1fe6ecc1249711";

const ARCHIVE_STORE = "job-posts-archive";

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

  const action = url.searchParams.get("action") || "status";

  /* ── 1. állapot: mi van a blob store-ban, mit fed le a mentett stats ── */
  if (action === "status") {
    const client = await pool.connect();
    try {
      const store = getStore(ARCHIVE_STORE);
      const { blobs } = await store.list();
      const archive = [];
      for (const b of blobs) {
        let payload = null;
        try {
          payload = await store.get(b.key, { type: "json" });
        } catch (err) {
          archive.push({ key: b.key, error: err.message });
          continue;
        }
        const rows = payload?.rows || [];
        const days = rows.map((r) => String(r.first_seen).slice(0, 10)).sort();
        archive.push({
          key: b.key,
          count: rows.length,
          exportedAt: payload?.exportedAt || null,
          firstSeenFrom: days[0] || null,
          firstSeenTo: days[days.length - 1] || null,
        });
      }

      const { rows: statsRange } = await client.query(
        `SELECT MIN(date)::text AS min_date, MAX(date)::text AS max_date,
                COUNT(*)::int AS days, SUM(total_jobs)::int AS total
           FROM job_daily_stats`
      );
      const { rows: catRange } = await client.query(
        `SELECT MIN(date)::text AS min_date, MAX(date)::text AS max_date,
                COUNT(*)::int AS rows
           FROM job_daily_categories`
      );
      const { rows: postsRange } = await client.query(
        `SELECT MIN((first_seen AT TIME ZONE 'UTC')::date)::text AS min_day,
                MAX((first_seen AT TIME ZONE 'UTC')::date)::text AS max_day,
                COUNT(*)::int AS rows
           FROM job_posts`
      );
      const jobCategories = await loadCategories();

      return json(200, {
        ok: true,
        archive,
        archiveTotalRows: archive.reduce((s, a) => s + (a.count || 0), 0),
        jobDailyStats: statsRange[0],
        jobDailyCategories: catRange[0],
        jobPosts: postsRange[0],
        dbCategories: jobCategories.map(([name]) => name),
      });
    } catch (err) {
      console.error("[tmp_stats_rebuild:status]", err);
      return json(500, { error: err.message });
    } finally {
      client.release();
    }
  }

  /* ── 2. hiányzó archívum-blob feltöltése ─────────────────────────── */
  if (action === "upload") {
    if (request.method !== "POST") return json(405, { error: "POST kell" });
    const key = url.searchParams.get("key");
    if (!key || !/^job-posts-archive-[0-9-]+\.json$/.test(key)) {
      return json(400, { error: "key formátuma: job-posts-archive-YYYY-MM-DD[-HH].json" });
    }
    let payload;
    try {
      payload = await request.json();
    } catch (err) {
      return json(400, { error: `érvénytelen JSON body: ${err.message}` });
    }
    if (!Array.isArray(payload?.rows) || payload.rows.length === 0) {
      return json(400, { error: "a body-ban nincs nem-üres rows tömb" });
    }
    const store = getStore(ARCHIVE_STORE);
    const existing = await store.get(key, { type: "json" }).catch(() => null);
    if (existing && url.searchParams.get("force") !== "1") {
      return json(409, {
        error: "ez a kulcs már létezik a store-ban",
        key,
        existingCount: existing?.rows?.length ?? null,
        hint: "force=1 felülírja",
      });
    }
    await store.set(key, JSON.stringify(payload, null, 2), {
      metadata: { type: "job-posts-archive", count: payload.rows.length },
    });
    return json(200, { ok: true, uploaded: key, rows: payload.rows.length, overwrote: !!existing });
  }

  /* ── 3. újraépítés ───────────────────────────────────────────────── */
  if (action === "rebuild") {
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
      const compact = url.searchParams.get("compact") === "1";
      return json(200, {
        ok: true,
        categoriesLoaded: jobCategories.map(([name]) => name),
        ...result,
        perDay: compact ? `${result.perDay?.length ?? 0} nap (elrejtve)` : result.perDay,
      });
    } catch (err) {
      console.error("[tmp_stats_rebuild:rebuild]", err);
      return json(500, { error: err.message });
    } finally {
      client.release();
    }
  }

  /* ── 4. csak az archívum beolvasása (méret-/időzítés-teszt) ──────── */
  if (action === "archive") {
    try {
      const { rows, blobs } = await loadArchiveRows();
      return json(200, { ok: true, rows: rows.length, blobs });
    } catch (err) {
      return json(500, { error: err.message });
    }
  }

  return json(400, { error: `ismeretlen action: ${action}` });
});
