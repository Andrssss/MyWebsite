// TEMPORARY one-off endpoint — merges the profession.hu city-slug duplicate
// rows (same job id, different city-suffixed url — see DUPLICATE_CITY_SLUGS
// in _profession_core.mjs) that were already in job_posts before that fix
// shipped. Deployed, invoked once, then deleted. Do not leave this in the
// repo; if you're reading this later and it's still here, it should have
// been removed right after use (see conversation history).
import pkg from "pg";
const { Pool } = pkg;

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });
const ONE_OFF_TOKEN = "5b829efc33fa43d3986f7be9fe4fff3812ef8693db066099";

const GROUPS = [
  {
    canonicalUrl:
      "https://www.profession.hu/allas/software-test-automation-specialist-all-genders-adesso-business-consulting-kft-2953010",
    urls: [
      "https://www.profession.hu/allas/software-test-automation-specialist-all-genders-adesso-business-consulting-kft-pecs-2953010",
      "https://www.profession.hu/allas/software-test-automation-specialist-all-genders-adesso-business-consulting-kft-debrecen-2953010",
    ],
  },
  {
    canonicalUrl:
      "https://www.profession.hu/allas/business-tester-all-genders-adesso-business-consulting-kft-2953020",
    urls: [
      "https://www.profession.hu/allas/business-tester-all-genders-adesso-business-consulting-kft-pecs-2953020",
      "https://www.profession.hu/allas/business-tester-all-genders-adesso-business-consulting-kft-debrecen-2953020",
    ],
  },
  {
    canonicalUrl:
      "https://www.profession.hu/allas/aws-security-governance-deutsche-telekom-tsi-hungary-kft-2954610",
    urls: [
      "https://www.profession.hu/allas/aws-security-governance-deutsche-telekom-tsi-hungary-kft-pecs-2954610",
      "https://www.profession.hu/allas/aws-security-governance-deutsche-telekom-tsi-hungary-kft-szeged-2954610",
      "https://www.profession.hu/allas/aws-security-governance-deutsche-telekom-tsi-hungary-kft-debrecen-2954610",
    ],
  },
  {
    canonicalUrl:
      "https://www.profession.hu/allas/web-app-frontend-developer-ref-x-deutsche-telekom-tsi-hungary-kft-2943113",
    urls: [
      "https://www.profession.hu/allas/web-app-frontend-developer-ref-x-deutsche-telekom-tsi-hungary-kft-szeged-2943113",
      "https://www.profession.hu/allas/web-app-frontend-developer-ref-x-deutsche-telekom-tsi-hungary-kft-debrecen-2943113",
    ],
  },
];

function mergeTechnologies(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    for (const t of String(r.technologies || "").split(",").map((s) => s.trim()).filter(Boolean)) {
      const key = t.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        out.push(t);
      }
    }
  }
  return out.length ? out.join(", ") : null;
}

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (token !== ONE_OFF_TOKEN) return new Response("Unauthorized", { status: 401 });

  const client = await pool.connect();
  const results = [];
  try {
    for (const group of GROUPS) {
      const { rows } = await client.query(
        `SELECT id, url, first_seen, active, experience, technologies, company
         FROM job_posts
         WHERE source = 'profession-intern' AND url = ANY($1::text[])
         ORDER BY first_seen ASC`,
        [group.urls]
      );
      if (rows.length < 2) {
        results.push({ canonicalUrl: group.canonicalUrl, skipped: true, found: rows.length });
        continue;
      }

      const keep = rows[0];
      const dropIds = rows.slice(1).map((r) => r.id);
      const active = rows.some((r) => r.active);
      const experience = rows.map((r) => r.experience).find((e) => e && e !== "-") || keep.experience;
      const technologies = mergeTechnologies(rows);
      const company = rows.map((r) => r.company).find(Boolean) || keep.company;

      await client.query("BEGIN");
      try {
        await client.query(`DELETE FROM job_posts WHERE id = ANY($1::int[])`, [dropIds]);
        await client.query(
          `UPDATE job_posts SET url = $1, active = $2, experience = $3, technologies = $4, company = $5
           WHERE id = $6`,
          [group.canonicalUrl, active, experience, technologies, company, keep.id]
        );
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }

      results.push({
        canonicalUrl: group.canonicalUrl,
        keptId: keep.id,
        deletedIds: dropIds,
        active,
        experience,
        technologies,
        company,
      });
    }
  } finally {
    client.release();
  }

  return new Response(JSON.stringify(results, null, 2), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
