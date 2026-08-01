// TEMPORARY one-off — the AI discovery routine's `technologies` field was free
// text, not constrained to the site's curated TECH_KEYWORDS list
// (_experience_core.mjs). Four rows manually submitted 2026-08-01 got
// non-recognized labels (SharePoint, Power Automate, Fortinet, Palo Alto,
// Cisco, VPN, Generative AI, Claude, Prompt Engineering). This trims each row
// to only the subset that IS a real TECH_KEYWORDS label (or clears it).
// Delete after use.
import pkg from "pg";
const { Pool } = pkg;

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });
const ONE_OFF_TOKEN = "015fc6d5729478fb56492d0673261cd0a0a0353bd78b3363";

const FIXES = [
  {
    url: "https://www.electronholding.com/jobs/ai-integration-specialist-junior",
    technologies: "LLM",
  },
  {
    url: "https://www.electronholding.com/jobs/alkalmazasuzemelteto",
    technologies: null,
  },
  {
    url: "https://www.electronholding.com/jobs/halozati-rendszermernok",
    technologies: "Azure",
  },
];

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
    const results = [];
    for (const fix of FIXES) {
      const res = await client.query(
        `UPDATE job_posts SET technologies = $2 WHERE source = 'AI-scraped' AND url = $1 RETURNING url, technologies`,
        [fix.url, fix.technologies]
      );
      results.push(...res.rows);
    }
    return json(200, { updated: results });
  } finally {
    client.release();
  }
};
