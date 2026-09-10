// DISPOSABLE — one-off cleanup for the 2026-09-10 job_filters revert window.
// Delete this file (and deploy that deletion) once used. See
// deploy-and-oneoff-writes-workflow memory for the pattern.
import { Pool } from "pg";

const TOKEN = "64e6c0b33955a4731f4dc68b678fba3aca353c974edd7396";

const WORDS = [
  "koordinátor", "Management", "Salesforce", "Helpdesk", "service desk",
  "technical support", "Customer Support", "Support Analyst", "CPQ Support",
  "END USER", "Tesztmenedzsment", "plm consultant", "Hálózatmérnök",
];

function normalize(s) {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function wordRegex(word) {
  const escaped = normalize(word).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i");
}

const REGEXES = WORDS.map((w) => ({ word: w, re: wordRegex(w) }));

export default async (request) => {
  const auth = request.headers.get("authorization") || "";
  if (auth !== `Bearer ${TOKEN}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const url = new URL(request.url);
  const doDelete = url.searchParams.get("action") === "delete";

  const pool = new Pool({
    connectionString: process.env.NETLIFY_DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT id, source, title, url, active, first_seen
       FROM job_posts
       WHERE first_seen >= now() - interval '2 days'
       ORDER BY first_seen DESC`
    );

    const hits = [];
    for (const row of rows) {
      const n = normalize(row.title);
      for (const { word, re } of REGEXES) {
        if (re.test(n)) {
          hits.push({ ...row, matchedWord: word });
          break;
        }
      }
    }

    let deletedCount = 0;
    if (doDelete && hits.length) {
      const ids = hits.map((h) => h.id);
      const result = await client.query(
        `DELETE FROM job_posts WHERE id = ANY($1::int[])`,
        [ids]
      );
      deletedCount = result.rowCount;
    }

    return new Response(
      JSON.stringify({ scannedSince: "2 days", count: hits.length, hits, deleted: doDelete, deletedCount }, null, 2),
      { headers: { "Content-Type": "application/json" } }
    );
  } finally {
    client.release();
    await pool.end();
  }
};
