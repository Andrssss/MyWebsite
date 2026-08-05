// Disposable one-off endpoint (2026-08-05): delete existing LinkedIn rows
// from "Poetry Cove", now blocked going forward via _company_blocklist.mjs.
// Deploy -> invoke -> delete this file.
const { Pool } = require("pg");
const { withDbAuditFlush } = require("./_db_audit.js");

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

const TOKEN = "pc-cleanup-8f2a4d9e1b7c6f30";

exports.handler = withDbAuditFlush("tmp-delete-poetry-cove", async (event) => {
  const hdr =
    (event.headers && (event.headers.authorization || event.headers.Authorization)) || "";
  const token = hdr.replace(/^Bearer\s+/i, "").trim();
  if (token !== TOKEN) {
    return { statusCode: 401, body: "Unauthorized" };
  }

  const client = await pool.connect();
  try {
    const result = await client.query(
      `DELETE FROM job_posts WHERE source = 'LinkedIn' AND LOWER(company) = 'poetry cove' RETURNING url, title`
    );
    return {
      statusCode: 200,
      body: JSON.stringify({ deleted: result.rowCount, rows: result.rows }),
    };
  } finally {
    client.release();
  }
});
