// DISPOSABLE — 2026-09-15. Direct lookup of the reported Tulip "DevX Engineer"
// (gh_jid=7821217003) row's current DB state, plus the ats-state tenant record
// for greenhouse:tulip. Delete after use.
import { Pool } from "pg";
import { readTenants, tenantKey } from "./_ats_state.mjs";

const TOKEN = "3444d3b9034ca77000d602c4adaecbed22e4551b";
const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });

  const client = await pool.connect();
  let rows;
  try {
    ({ rows } = await client.query(
      `SELECT *
       FROM job_posts
       WHERE url ILIKE $1 OR (title ILIKE $2 AND company ILIKE $3)
       ORDER BY id`,
      ["%7821217003%", "%DevX Engineer%", "%Tulip%"]
    ));
  } finally {
    client.release();
  }

  const tenants = await readTenants();
  const tenant = tenants[tenantKey("greenhouse", "tulip")] ?? null;

  return new Response(JSON.stringify({ rows, tenant }, null, 2), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
};
