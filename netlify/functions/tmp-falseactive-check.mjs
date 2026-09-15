// DISPOSABLE — 2026-09-15. Row lookup for 8 user-reported false-active
// AI-scraped postings (Direktor Szoftver, NAIH, Qube, NISZ x2, Lechner x3).
// Read-only. Delete after use.
import { Pool } from "pg";

const TOKEN = "5032523398ec0dfe5a65ec7d9dde2f84c5a753fdccabf79a";
const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

const TARGETS = [
  ["Direktor Szoftver", "P%nz%gyi rendszerszervez%"],
  ["NAIH", "IT rendszer%zemeltet%"],
  ["Qube", "Quantitative Researcher"],
  ["NISZ", "IP h%l%zat%zemeltet%"],
  ["NISZ", "Automata szoftvertesztel%"],
  ["Lechner", "DevOps"],
  ["Lechner", "Automata tesztel%"],
  ["Lechner", "Medior Java fejleszt%"],
];

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });

  const client = await pool.connect();
  let results;
  try {
    results = [];
    for (const [company, title] of TARGETS) {
      const { rows } = await client.query(
        `SELECT id, source, url, active, sweep_dead, first_seen, title, company
         FROM job_posts
         WHERE company ILIKE $1 AND title ILIKE $2
         ORDER BY id`,
        [`%${company}%`, `%${title}%`]
      );
      results.push({ company, title, rows });
    }
  } finally {
    client.release();
  }

  return new Response(JSON.stringify(results, null, 2), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
};
