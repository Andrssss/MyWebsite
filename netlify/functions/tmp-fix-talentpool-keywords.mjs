// DISPOSABLE one-off write endpoint — delete after use.
//
// Issue #10 fix, validated via tmp-audit-talentpool.mjs against real
// job_posts titles before applying:
//   - `~future opportunit`  → 2 gains ("croatian/serbian" + "italian
//     speaking future opportunities"), 0 steals.
//   - `~speaking opportunit` → 2 gains ("french"/"german speaking
//     opportunities" — same BPO-collector-ad family, just missing the word
//     "future"), 0 steals.
//   - Deliberately NOT adding: bare `~opportunit` (stole a real Webfejlesztés
//     posting — "Software Engineer Java/Angular - Future Career
//     Opportunities") and `~future talent` (stole a real Fejlesztő posting —
//     "future talent - service engineer trainee").
//
//   curl -X POST "https://bakan7.netlify.app/.netlify/functions/tmp-fix-talentpool-keywords" \
//     -H "Authorization: Bearer 97f2ac1ab46e1d24943e678c9d7de498186bfa51dbda6079"

import { Pool } from "pg";

const TOKEN = "97f2ac1ab46e1d24943e678c9d7de498186bfa51dbda6079";
const NEW_KEYWORDS = ["~future opportunit", "~speaking opportunit"];

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

function json(status, body) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export default async (request) => {
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (token !== TOKEN) return json(401, { error: "Unauthorized" });
  if (request.method !== "POST") return json(405, { error: "POST only" });

  const client = await pool.connect();
  try {
    const { rows: before } = await client.query(
      `SELECT id, keywords FROM job_categories WHERE name = 'Talent Pool'`
    );
    if (before.length === 0) return json(404, { error: "Talent Pool category not found" });

    const toAdd = NEW_KEYWORDS.filter((k) => !before[0].keywords.includes(k));
    if (toAdd.length === 0) {
      return json(200, { noop: true, keywords: before[0].keywords });
    }

    const { rows: after } = await client.query(
      `UPDATE job_categories SET keywords = keywords || $2::text[]
       WHERE id = $1 RETURNING id, name, keywords`,
      [before[0].id, toAdd]
    );

    return json(200, { updated: true, added: toAdd, keywords: after[0].keywords });
  } finally {
    client.release();
  }
};
