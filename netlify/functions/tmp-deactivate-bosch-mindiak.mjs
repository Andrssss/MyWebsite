// Disposable one-off (2026-08-11): deactivate existing rows for companies
// now blocked going forward via _company_blocklist.mjs — LinkedIn "bosch
// hungary" (duplicates wherewework/AI-scraped Bosch postings) and
// profession-intern "Mind-Diák Szövetkezet" (duplicates minddiak postings
// under the real employer name). Deploy -> invoke -> delete this file.

import { Pool } from "pg";
import { withDbAuditFlush } from "./_db_audit.js";

const connectionString = process.env.NETLIFY_DATABASE_URL;
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

const TOKEN = "bosch-mindiak-cleanup-3f9e71ac2b0d";

export default withDbAuditFlush("tmp-deactivate-bosch-mindiak", async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (token !== TOKEN) return new Response("Unauthorized", { status: 401 });

  const client = await pool.connect();
  try {
    const bosch = await client.query(
      `UPDATE job_posts SET active = false
        WHERE source = 'LinkedIn' AND LOWER(company) = 'bosch hungary' AND active = true
        RETURNING url, title`
    );
    const mindiak = await client.query(
      `UPDATE job_posts SET active = false
        WHERE source = 'profession-intern' AND LOWER(company) = 'mind-diák szövetkezet' AND active = true
        RETURNING url, title`
    );
    return new Response(
      JSON.stringify({ bosch: bosch.rows, mindiak: mindiak.rows }),
      { headers: { "Content-Type": "application/json" } }
    );
  } finally {
    client.release();
  }
});