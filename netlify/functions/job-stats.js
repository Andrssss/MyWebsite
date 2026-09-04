// netlify/functions/job-stats.js
// API endpoint: GET /.netlify/functions/job-stats
// Returns daily stats for the last 30 days + last 10 days.
//
// job_daily_stats / job_daily_categories moved from Postgres to a Netlify
// Blob (2026-09-04) — see _daily_stats_store.mjs. This endpoint no longer
// touches the DB at all; it reads the whole blob and reproduces the same
// date-range/grouping logic in JS that used to be SQL.

function jsonResponse(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "https://bakan7.netlify.app",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}

// Public on purpose: these are the same aggregate daily counts pestidev.hu's
// own stats page already shows to anyone (and, since the 2026-09-04 blob
// migration, reads from the exact same "job-stats" blob) — gating this
// repo's copy protected nothing, it was just caught in the 2026-08-25
// /allasfigyelo blanket admin-only lockdown along with the actual admin
// data (jobs.js's `hidden` rows, etc.), which stays gated.
exports.handler = async () => {
  try {
    const { readDailyStats } = await import("./_daily_stats_store.mjs");
    const { dailyStats, dailyCategories } = await readDailyStats();

    const now = new Date();
    const currentMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const rolling30DayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 29));
    const rolling30DayStartStr = rolling30DayStart.toISOString().slice(0, 10);
    const monthlyWindowStart = new Date(currentMonthStart);
    monthlyWindowStart.setUTCMonth(monthlyWindowStart.getUTCMonth() - 5);
    const monthlyWindowStartStr = monthlyWindowStart.toISOString().slice(0, 10);

    const statsAsc = [...dailyStats].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

    // Elmúlt 30 nap adatai
    const monthRows = statsAsc.filter((r) => r.date >= rolling30DayStartStr);

    // Utolsó 10 napi adatok (dátum szerint csökkenő, majd visszafordítva —
    // ugyanaz a sorrend, mint a régi SQL ORDER BY date DESC LIMIT 10 .reverse())
    const last10Rows = [...statsAsc].slice(-10);

    // Összes adat
    const allDaysRows = statsAsc;

    // Havi összesítés (utolsó 6 hónap)
    const monthlyMap = new Map();
    for (const row of statsAsc) {
      if (row.date < monthlyWindowStartStr) continue;
      const month = row.date.slice(0, 7);
      const existing = monthlyMap.get(month) || { total_jobs: 0, intern_jobs: 0 };
      existing.total_jobs += row.total_jobs;
      existing.intern_jobs += row.intern_jobs;
      monthlyMap.set(month, existing);
    }

    const monthlyTotals = Array.from({ length: 6 }, (_, index) => {
      const monthDate = new Date(Date.UTC(
        monthlyWindowStart.getUTCFullYear(),
        monthlyWindowStart.getUTCMonth() + index,
        1
      ));
      const monthKey = monthDate.toISOString().slice(0, 7);
      const existing = monthlyMap.get(monthKey);

      return {
        month: monthKey,
        total_jobs: existing?.total_jobs ?? 0,
        intern_jobs: existing?.intern_jobs ?? 0,
      };
    });

    const sumCategories = (dateFrom, { internOnly = false } = {}) => {
      const totals = new Map();
      for (const row of dailyCategories) {
        if (row.date < dateFrom) continue;
        const isIntern = row.category.startsWith("intern:");
        if (internOnly !== isIntern) continue;
        const key = internOnly ? row.category.slice(7) : row.category;
        totals.set(key, (totals.get(key) || 0) + row.count);
      }
      return [...totals.entries()]
        .map(([category, count]) => ({ category, count }))
        .sort((a, b) => b.count - a.count);
    };

    // Elmúlt 30 nap kategória bontás
    const monthCategories = sumCategories(rolling30DayStartStr);

    // 6 havi kategória bontás
    const weekCategories = sumCategories(monthlyWindowStartStr);

    // 6 havi intern/diák kategória bontás ("intern:" prefix)
    const internCategories6m = sumCategories(monthlyWindowStartStr, { internOnly: true });

    return jsonResponse(200, {
      month: monthRows,
      last10: last10Rows,
      allDays: allDaysRows,
      monthlyTotals,
      monthCategories,
      weekCategories,
      internCategories6m,
    });
  } catch (err) {
    console.error("[job-stats] Error:", err);
    return jsonResponse(500, { error: err.message });
  }
};
