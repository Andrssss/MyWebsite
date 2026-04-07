// netlify/functions/job-stats.js
// API endpoint: GET /.netlify/functions/job-stats
// Returns daily stats for the current month + last 10 days.

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
    // Aktuális hónap első napja
    const now = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;

    // Havi adatok
    const { rows: monthRows } = await client.query(
      `SELECT date, total_jobs, intern_jobs
       FROM job_daily_stats
       WHERE date >= $1
       ORDER BY date ASC`,
      [monthStart]
    );

    // Utolsó 10 napi adatok
    const { rows: last10Rows } = await client.query(
      `SELECT date, total_jobs, intern_jobs
       FROM job_daily_stats
       ORDER BY date DESC
       LIMIT 10`
    );

    return jsonResponse(200, {
      month: monthRows,
      last10: last10Rows.reverse(), // legrégebbi elöl
    });
  } catch (err) {
    console.error("[job-stats] Error:", err);
    return jsonResponse(500, { error: err.message });
  } finally {
    client.release();
  }
};
