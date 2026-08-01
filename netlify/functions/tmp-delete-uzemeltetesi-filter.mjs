// TEMPORARY one-off — deletes the overly-broad bare "uzemeltetesi" job_filters
// word (id 360). It was blocking genuinely-IT titles like zyntern's "IT
// üzemeltetési és biztonsági gyakornok" (verified via the posting's own
// description: IT helpdesk/CMDB/Windows/hálózat content) — "üzemeltetés" is
// the standard Hungarian term for IT/systems operations too, not just
// building/energy/fleet operations. Three narrower entries already cover the
// genuinely non-IT cases (energetikai rendszeruzemelteto, epuletuzemeltetesi,
// flottauzemeltetesi), so this bare word is redundant collateral damage.
// User request 2026-08-01. Delete this file after use.
import pkg from "pg";
const { Pool } = pkg;

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });
const ONE_OFF_TOKEN = "488b6eec7be2572410dc3b542a471d3ed5f5c85c55436a99";

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export default async (request) => {
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (token !== ONE_OFF_TOKEN) return json(401, { error: "Unauthorized" });

  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `DELETE FROM job_filters WHERE id = 360 AND word = 'uzemeltetesi' RETURNING id, word`
    );
    return json(200, { deleted: rows });
  } finally {
    client.release();
  }
};
