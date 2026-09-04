// netlify/functions/_stats_rebuild_core.mjs
//
// A job_daily_stats + job_daily_categories NULLÁRÓL való újraépítése a nyers
// álláshirdetésekből. Két forrásból dolgozik, mert a nyers sorok két helyen
// laknak:
//   1) job_posts — minden, ami még az élő táblában van;
//   2) "job-posts-archive" Netlify Blob store — a cron_jobposts_cleanup által
//      havonta kimentett és a DB-ből TÖRÖLT régi sorok. Enélkül a ~60 napnál
//      régebbi napok 0-ra épülnének újra.
// A kettő uniója = a teljes ismert előélet (kivéve a kézzel purge-olt sorokat,
// amik az archívum 2026-08-18-as bevezetése ELŐTT tűntek el — azok végleg oda
// vannak, az ő napjaik így kicsit alacsonyabbak lesznek az eredetinél).
//
// Miért kell újraépíteni egyáltalán: a mentett statisztika a beírás
// pillanatában érvényes kategória-szabályokkal és kategórianevekkel készült.
// Amikor a board kategóriái változnak (átnevezés, új/törölt kategória, más
// kulcsszavak a job_categories táblában), a régi sorok elavulnak — a nyers
// hirdetésekből viszont a MAI szabályokkal bármikor újraszámolhatók.

import { getStore } from "@netlify/blobs";
import { computeDayStats } from "./_stats_core.mjs";
import { replaceDays } from "./_daily_stats_store.mjs";

const ARCHIVE_STORE = "job-posts-archive";

function utcDay(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/* ── 1. archivált sorok beolvasása a blob store-ból ──────────────── */

export async function loadArchiveRows() {
  const store = getStore(ARCHIVE_STORE);
  const { blobs } = await store.list();
  const blobReport = [];
  const rows = [];

  for (const blob of blobs) {
    let payload;
    try {
      payload = await store.get(blob.key, { type: "json" });
    } catch (err) {
      blobReport.push({ key: blob.key, error: err.message });
      continue;
    }
    const blobRows = payload?.rows || [];
    blobReport.push({ key: blob.key, count: blobRows.length });
    for (const row of blobRows) rows.push(row);
  }

  return { rows, blobs: blobReport };
}

/* ── 2. élő + archivált sorok egyesítése ─────────────────────────── */

// A sor identitása (source, url) — ugyanaz, amit a cron_jobposts_cleanup is
// használ. Az archívum önmagával is átfedhet: egy LinkedIn-hirdetés
// archiválás után percekkel visszakerülhet a táblába, majd újra archiválódik.
// Ilyenkor EGY hirdetésnek számít, a LEGKORÁBBI first_seen napján — a "hány ÚJ
// hirdetés jött aznap" kérdésre a visszatérés nem új hirdetés.
export function mergeRows(liveRows, archiveRows) {
  const byKey = new Map();
  let collapsed = 0;

  const add = (row, isLive) => {
    const day = row.day || utcDay(row.first_seen);
    if (!day) return;
    const key = `${row.source}|${row.url}`;
    const entry = {
      title: row.title,
      source: row.source,
      experience: row.experience,
      day,
      live: isLive,
    };
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, entry);
      return;
    }
    collapsed++;
    // Az élő sor adatai frissebbek (pl. időközben javított experience), de a
    // nap mindig a legkorábbi ismert first_seen.
    const earliestDay = existing.day < entry.day ? existing.day : entry.day;
    const winner = entry.live ? entry : existing;
    byKey.set(key, { ...winner, day: earliestDay });
  };

  for (const row of archiveRows) add(row, false);
  for (const row of liveRows) add(row, true);

  return { rows: [...byKey.values()], collapsed };
}

/* ── 3. újraépítés ───────────────────────────────────────────────── */

export function groupByDay(rows, { from, to } = {}) {
  const byDay = new Map();
  for (const row of rows) {
    if (from && row.day < from) continue;
    if (to && row.day > to) continue;
    if (!byDay.has(row.day)) byDay.set(row.day, []);
    byDay.get(row.day).push(row);
  }
  return byDay;
}

export async function fetchLiveRows(client, { from, to } = {}) {
  const conditions = [];
  const params = [];
  if (from) {
    params.push(from);
    conditions.push(`(first_seen AT TIME ZONE 'UTC')::date >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    conditions.push(`(first_seen AT TIME ZONE 'UTC')::date <= $${params.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const { rows } = await client.query(
    `SELECT title, source, experience, url,
            TO_CHAR((first_seen AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day
       FROM job_posts
       ${where}`,
    params
  );
  return rows;
}

// Egyetlen blob-írásban: a megadott tartomány TELJES cseréje az újraszámolt
// napokra (replaceDays maga olvassa be a jelenlegi blobot, szűri ki a
// tartományt, majd egyben ír vissza — nincs félig-üres közbenső állapot,
// mert a régi sorok a sikeres írásig megmaradnak).
export async function writeDays(byDay, jobCategories, { from, to }) {
  const days = [...byDay.keys()].sort();
  const perDay = [];
  const statRows = [];
  const catRows = [];

  for (const day of days) {
    const { totalJobs, internJobs, categories, internCategories } =
      computeDayStats(byDay.get(day), jobCategories);

    // A 0 találatos napokat nem tároljuk (a régi backfill is így tett).
    if (totalJobs === 0) {
      perDay.push({ date: day, total_jobs: 0, intern_jobs: 0, skipped: true });
      continue;
    }

    statRows.push({ date: day, total_jobs: totalJobs, intern_jobs: internJobs });
    for (const { category, count } of categories) catRows.push({ date: day, category, count });
    for (const { category, count } of internCategories)
      catRows.push({ date: day, category: `intern:${category}`, count });

    perDay.push({
      date: day,
      total_jobs: totalJobs,
      intern_jobs: internJobs,
      categories: categories.length,
      intern_categories: internCategories.length,
    });
  }

  await replaceDays(statRows, catRows, { from, to });

  return {
    insertedStats: statRows.length,
    insertedCategories: catRows.length,
    perDay,
  };
}

/* ── teljes futtatás egy hívásban ────────────────────────────────── */

export async function rebuildStats(client, jobCategories, { from, to, dryRun = false } = {}) {
  const startedAt = Date.now();

  const liveRows = await fetchLiveRows(client, { from, to });
  const { rows: rawArchiveRows, blobs } = await loadArchiveRows();
  const archiveRows = rawArchiveRows.map((r) => ({ ...r, day: utcDay(r.first_seen) }));

  const { rows: merged, collapsed } = mergeRows(liveRows, archiveRows);
  const byDay = groupByDay(merged, { from, to });

  const days = [...byDay.keys()].sort();
  const summary = {
    from: from || days[0] || null,
    to: to || days[days.length - 1] || null,
    liveRows: liveRows.length,
    archiveRows: archiveRows.length,
    archiveBlobs: blobs,
    duplicatesCollapsed: collapsed,
    days: days.length,
    dryRun,
  };

  if (dryRun) {
    const preview = [];
    for (const day of days) {
      const { totalJobs, internJobs, categories } = computeDayStats(byDay.get(day), jobCategories);
      preview.push({
        date: day,
        total_jobs: totalJobs,
        intern_jobs: internJobs,
        categories: categories.length,
      });
    }
    return { ...summary, ms: Date.now() - startedAt, perDay: preview };
  }

  const written = await writeDays(byDay, jobCategories, {
    from: summary.from,
    to: summary.to,
  });
  return { ...summary, ...written, ms: Date.now() - startedAt };
}
