// netlify/functions/tmp-stats-rebuild.mjs
//
// ELDOBHATÓ, egyszer használatos endpoint (2026-09-01, 2. menet): a
// job_daily_stats + job_daily_categories újraépítése NULLÁRÓL, miután a
// besorolás átállt a pestidev.hu (allasfigyelo repo) 1-1 portjára.
// A tényleges logika a _stats_rebuild_core.mjs + _stats_core.mjs párosban van
// (azok maradnak); ez csak a futtató kapu. Használat után `git rm`-mel törlendő.
//
//   # kategória-kulcsszavak kidumpolása (a port helyi ellenőrzéséhez):
//   curl -s ".../tmp-stats-rebuild?token=TOKEN&action=categories"
//
//   # állapot (archívum-blobok + a stats lefedettsége):
//   curl -s ".../tmp-stats-rebuild?token=TOKEN&action=status"
//
//   # szárazon / élesen (GET mindig száraz, írni csak POST-tal lehet):
//   curl -s      ".../tmp-stats-rebuild?token=TOKEN&action=rebuild&compact=1"
//   curl -s -X POST ".../tmp-stats-rebuild?token=TOKEN&action=rebuild&compact=1"

import { getStore } from "@netlify/blobs";
import pkg from "pg";
const { Pool } = pkg;
import { loadCategories } from "./load_categories.mjs";
import { rebuildStats } from "./_stats_rebuild_core.mjs";
import { withDbAuditFlush } from "./_db_audit.js";

// Egyszer használatos, ebbe a fájlba generált token — szándékosan NEM env var
// (a CRON_SECRET maszkolt a CLI-ban), és a fájllal együtt megszűnik.
const TOKEN = "9d02c1a4e58b7f36ac41905e2db8f7c31a6e";

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

  /* ── kategória-kulcsszavak (a helyi 1-1 ellenőrzéshez) ───────────── */
  if (action === "categories") {
    try {
      const cats = await loadCategories();
      return json(200, { ok: true, count: cats.length, categories: cats });
    } catch (err) {
      return json(500, { error: err.message });
    }
  }

  /* ── állapot: archívum-blobok + a mentett stats lefedettsége ─────── */
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
        archive.push({ key: b.key, count: (payload?.rows || []).length });
      }

      const { rows: statsRange } = await client.query(
        `SELECT MIN(date)::text AS min_date, MAX(date)::text AS max_date,
                COUNT(*)::int AS days, SUM(total_jobs)::int AS total,
                SUM(intern_jobs)::int AS intern
           FROM job_daily_stats`
      );
      const { rows: topCats } = await client.query(
        `SELECT category, SUM(count)::int AS count
           FROM job_daily_categories
          WHERE category NOT LIKE 'intern:%'
          GROUP BY category ORDER BY count DESC`
      );
      return json(200, {
        ok: true,
        archive,
        archiveTotalRows: archive.reduce((s, a) => s + (a.count || 0), 0),
        jobDailyStats: statsRange[0],
        categoryTotals: topCats,
      });
    } catch (err) {
      console.error("[tmp_stats_rebuild:status]", err);
      return json(500, { error: err.message });
    } finally {
      client.release();
    }
  }

  /* ── újraépítés ──────────────────────────────────────────────────── */
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

  return json(400, { error: `ismeretlen action: ${action}` });
});
