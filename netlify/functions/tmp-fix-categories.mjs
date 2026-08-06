// Disposable one-off endpoint (2026-08-06): (1) remove "C++" as a standalone
// job_categories row (it was a single-keyword category outranking every
// role-based one in the tie-break priority — see CATEGORY_PRIORITY removal
// in cron_daily_stats.mjs / JobWatcher.jsx / allasfigyelo's categorize.ts),
// folding "c++" into Fejlesztő's keywords instead; (2) seed a draft
// technologies[] mapping for every remaining category (auto-selected as
// tech filters when a category chip is picked — editable afterward via the
// admin Categories UI). Deploy -> invoke -> delete.
import { Pool } from "pg";

const connectionString = process.env.NETLIFY_DATABASE_URL;
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

const TOKEN = "fix-categories-9d2e6b41c8a7f350";

const TECH_BY_CATEGORY = {
  "Webfejlesztés": ["React", "Vue", "Angular", "TypeScript", "JavaScript", "Next.js", "Nuxt", "HTML", "CSS", "Node.js", "PHP", "Laravel", "WordPress", ".NET"],
  "Data / AI": ["Python", "SQL", "Machine Learning", "Deep Learning", "NLP", "PyTorch", "TensorFlow", "Power BI", "Databricks", "Apache Spark", "LLM", "Data Science"],
  "DevOps": ["Docker", "Kubernetes", "Terraform", "AWS", "Azure", "GCP", "CI/CD", "Ansible", "Jenkins", "GitLab", "Prometheus", "Grafana"],
  "QA / Tesztelő": ["Selenium", "Cypress", "Playwright", "JMeter", "Postman", "TestNG", "JUnit", "ISTQB", "Test Automation", "Manual Testing", "SoapUI"],
  "Security": ["SIEM", "Splunk", "CISSP", "OSCP", "CEH", "Penetration Testing", "Cybersecurity", "Wireshark", "Fortinet", "Palo Alto Networks"],
  "Hálózat / Infra": ["Cisco", "Linux", "Windows Server", "VMware", "Active Directory", "DNS", "DHCP", "VPN", "CCNA"],
  "Hardware": ["C++", "SCADA", "Modbus"],
  "Mobil": ["Android", "iOS", "Swift", "Kotlin", "Flutter", "React Native", "SwiftUI", "Xamarin"],
  "Fejlesztő": ["Java", "C#", ".NET", "C++", "Spring Boot", "Python", "PHP"],
  "Menedzser / PM": ["Jira", "Confluence", "Scrum", "Kanban"],
  "Mérnöki / Gyártás": ["MATLAB", "SCADA"],
  "Elemző / Analyst": ["SQL", "Power BI", "Tableau", "Excel", "Python", "Business Intelligence"],
};

export default async (req) => {
  const hdr = req.headers.get("authorization") || "";
  const token = hdr.replace(/^Bearer\s+/i, "").trim();
  if (token !== TOKEN) {
    return new Response("Unauthorized", { status: 401 });
  }

  const client = await pool.connect();
  try {
    await client.query(
      `ALTER TABLE job_categories ADD COLUMN IF NOT EXISTS technologies text[] NOT NULL DEFAULT '{}'`
    );

    const results = {};

    const fejleszto = await client.query(
      `UPDATE job_categories
       SET keywords = CASE WHEN 'c++' = ANY(keywords) THEN keywords ELSE array_append(keywords, 'c++') END
       WHERE name = 'Fejlesztő'
       RETURNING id, name, keywords`
    );
    results.fejlesztoKeywordUpdate = fejleszto.rows[0] || null;

    const deleted = await client.query(
      `DELETE FROM job_categories WHERE name = 'C++' RETURNING id, name, keywords`
    );
    results.deletedCppCategory = deleted.rows[0] || null;

    const techUpdates = [];
    for (const [name, techs] of Object.entries(TECH_BY_CATEGORY)) {
      const { rows } = await client.query(
        `UPDATE job_categories SET technologies = $2 WHERE name = $1 RETURNING id, name, technologies`,
        [name, techs]
      );
      techUpdates.push(rows[0] || { name, error: "not found" });
    }
    results.techUpdates = techUpdates;

    return new Response(JSON.stringify(results, null, 2), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } finally {
    client.release();
  }
};
