// netlify/functions/job-stats.js
// API endpoint: GET /.netlify/functions/job-stats
// Returns daily stats for the last 30 days + last 10 days.

const { Pool } = require("pg");

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "https://bakan7.netlify.app",
    },
    body: JSON.stringify(body),
  };
}

exports.handler = async () => {
  const client = await pool.connect();
  try {
    const now = new Date();
    const currentMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const rolling30DayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 29));
    const rolling30DayStartStr = rolling30DayStart.toISOString().slice(0, 10);
    const monthlyWindowStart = new Date(currentMonthStart);
    monthlyWindowStart.setUTCMonth(monthlyWindowStart.getUTCMonth() - 5);
    const monthlyWindowStartStr = monthlyWindowStart.toISOString().slice(0, 10);

    // Elmúlt 30 nap adatai
    const { rows: monthRows } = await client.query(
      `SELECT date, total_jobs, intern_jobs
       FROM job_daily_stats
       WHERE date >= $1
       ORDER BY date ASC`,
      [rolling30DayStartStr]
    );

    // Utolsó 10 napi adatok
    const { rows: last10Rows } = await client.query(
      `SELECT date, total_jobs, intern_jobs
       FROM job_daily_stats
       ORDER BY date DESC
       LIMIT 10`
    );

    // Összes adat (teljes DB)
    const { rows: allDaysRows } = await client.query(
      `SELECT date, total_jobs, intern_jobs
       FROM job_daily_stats
       ORDER BY date ASC`
    );

    const { rows: monthlyRows } = await client.query(
      `SELECT TO_CHAR(DATE_TRUNC('month', date), 'YYYY-MM') AS month,
              SUM(total_jobs)::int AS total_jobs,
              SUM(intern_jobs)::int AS intern_jobs
       FROM job_daily_stats
       WHERE date >= $1
       GROUP BY 1
       ORDER BY 1 ASC`,
      [monthlyWindowStartStr]
    );

    const monthlyMap = new Map(
      monthlyRows.map((row) => [row.month, row])
    );

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

    // Elmúlt 30 nap kategória bontás (mentett adatból)
    const { rows: monthCatRows } = await client.query(
      `SELECT category, SUM(count)::int AS count
       FROM job_daily_categories
       WHERE date >= $1
       GROUP BY category
       ORDER BY count DESC`,
      [rolling30DayStartStr]
    );
    const monthCategories = monthCatRows.map((r) => ({ category: r.category, count: r.count }));

    // 6 havi kategória bontás (mentett adatból)
    const { rows: weeklyCatRows } = await client.query(
      `SELECT category, SUM(count)::int AS count
       FROM job_daily_categories
       WHERE date >= $1
       GROUP BY category
       ORDER BY count DESC`,
      [monthlyWindowStartStr]
    );
    const weekCategories = weeklyCatRows.map((r) => ({ category: r.category, count: r.count }));

    return jsonResponse(200, {
      month: monthRows,
      last10: last10Rows.reverse(),
      allDays: allDaysRows,
      monthlyTotals,
      monthCategories,
      weekCategories,
    });
  } catch (err) {
    console.error("[job-stats] Error:", err);
    return jsonResponse(500, { error: err.message });
  } finally {
    client.release();
  }
};
