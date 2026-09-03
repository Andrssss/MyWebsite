// DISPOSABLE read-only investigation endpoint — 2026-09-04. Checks a fixed
// list of URLs (candidates from an earlier dry-run dupe audit) against the
// current job_posts table, to confirm which ones a separate hard-delete pass
// actually removed. No writes. Delete after use.

import { Pool } from "pg";

const TOKEN = "c3f9a1e0b7d24c5fa2e8419d0b6c7f3a1e5d9c2b";
const pool = new Pool({ connectionString: process.env.NETLIFY_DATABASE_URL, ssl: { rejectUnauthorized: false } });

const CHECK_URLS = [
  "https://hu.linkedin.com/jobs/view/frontend-engineer-at-qneiform-4460740196?position=13&pageNum=0&refId=nov6d%2FjEjCLDpYAr8S%2BNjw%3D%3D&trackingId=zUEy78gD2TqEiSMd9Xut8Q%3D%3D",
  "https://hu.talent.com/view?id=609662987098594933",
  "https://hu.talent.com/view?id=609663026838899281",
  "https://hu.talent.com/view?id=596026940125157714",
  "https://hu.linkedin.com/jobs/view/ai-engineer-at-k%C3%B6rber-campus-p%C3%A9cs-4459167566?position=11&pageNum=0&refId=hdWF5GpV7%2FC%2F4SS337cKJw%3D%3D&trackingId=ba%2BHtRmBiRL%2BJUq6gmjCcA%3D%3D",
  "https://hu.linkedin.com/jobs/view/system-administrator-student-at-abacus-medicine-group-4459989140?position=30&pageNum=0&refId=IJmRaYJHfRsdfdlhZgXZ0w%3D%3D&trackingId=t4o2ZFJDSQwXSQtKmBWPlg%3D%3D",
  "https://hu.linkedin.com/jobs/view/software-development-engineer-iii-java-at-tesco-technology-4437377692?position=3&pageNum=0&refId=wEAm8ZUg3ngbcYU8dTMWEQ%3D%3D&trackingId=7t%2Bkhymg%2BbT43TSu9OvyEw%3D%3D",
  "https://www.profession.hu/allas/it-business-analyst-advocate-business-consulting-informatikai-kft-2969680",
  "https://nofluffjobs.com/hu/job/cloud-devops-deutsche-telekom-it-solutions-hungary-budapest",
  "https://startup.jobs/backend-engineer-voyager-team-bridge-hungary-budapest-remote-ltg-8712837",
  "https://hu.talent.com/view?id=632714159537268696",
  "https://hu.talent.com/view?id=632712979561058053",
];

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) {
    return new Response("unauthorized", { status: 401 });
  }

  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT url, source, title, company, active, first_seen FROM job_posts WHERE url = ANY($1::text[])`,
      [CHECK_URLS]
    );
    const found = new Map(rows.map((r) => [r.url, r]));
    const results = CHECK_URLS.map((u) => ({
      url: u,
      status: found.has(u) ? (found.get(u).active ? "STILL ACTIVE" : "STILL PRESENT, INACTIVE") : "DELETED (not found)",
      row: found.get(u) || null,
    }));
    return new Response(JSON.stringify(results, null, 2), {
      headers: { "content-type": "application/json" },
    });
  } finally {
    client.release();
  }
};
