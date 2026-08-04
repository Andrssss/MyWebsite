// Disposable one-off: backfill technologies for the SIGNAL IDUNA junior
// tester row (profession-intern), inserted 2026-08-04 08:18 UTC before the
// title-shortcut fetch-before-insert fix (commit 47b9785) deployed same day.
// Delete after use.

import { Pool } from "pg";
import { extractTechnologies } from "./_experience_core.mjs";

const connectionString = process.env.NETLIFY_DATABASE_URL;
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

const TOKEN = "b7c7f27a83a7a8f2d4b4cdcac94c463007074a2dbf97a60b";

const URL =
  "https://www.profession.hu/allas/junior-szoftver-tesztelo-munkatars-signal-iduna-biztosito-zartkoruen-mukodo-reszvenytarsasag-2965215";

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (token !== TOKEN) return new Response("Unauthorized", { status: 401 });

  const res = await fetch(URL, {
    headers: { "User-Agent": "JobWatcher/1.0" },
  });
  if (!res.ok) return new Response(`Fetch failed: HTTP ${res.status}`, { status: 502 });
  const html = await res.text();

  const technologies = extractTechnologies(html);

  const client = await pool.connect();
  try {
    const result = await client.query(
      `UPDATE job_posts SET technologies = $1
        WHERE source = 'profession-intern' AND url = $2 AND technologies IS NULL
        RETURNING url, title, technologies`,
      [technologies, URL]
    );
    return new Response(
      JSON.stringify({ extracted: technologies, updated: result.rows }, null, 2),
      { headers: { "Content-Type": "application/json" } }
    );
  } finally {
    client.release();
  }
};
