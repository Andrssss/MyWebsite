// TEMPORARY one-off endpoint — ingest a small hand-vetted batch of 5 junior/
// intern IT postings found via a ChatGPT Deep Research pass (2026-07-30),
// filtered by hand against the career-pages-only / IT-title / not-senior /
// Budapest-or-remote rules before being hardcoded here. Reuses the SAME
// ingestJobs/sanitizeJobs core every other ai-scraped write path uses (IT gate,
// senior-title blacklist, location filter, company blocklist, upsert+reconcile
// in reactivate-only mode). One-off hardcoded token, same pattern as
// tmp-ai-candidate-ingest / tmp-onefix / tmp-muisz-kat4-delete. Delete this
// file after use.
import pkg from "pg";
const { Pool } = pkg;
import { loadFilters } from "./load_filters.mjs";
import { loadCategories } from "./load_categories.mjs";
import { ingestJobs, sanitizeJobs, AI_SOURCE } from "./_ai_ingest_core.mjs";

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });
const ONE_OFF_TOKEN = "17f9ba52f66abf94846f35678d7b069db07a3e45bbae551f";

const JOBS = [
  {
    title: "Junior AI Engineer",
    url: "https://atj.graphisoft.com/job/Budapest-Junior-AI-Engineer-1031/1353220757/?feedId=351702&tcsource=apply",
    company: "Graphisoft",
    location: "Budapest",
    experience: "0-2 years of hands-on experience in AI/ML, data engineering, or software engineering",
    technologies: "Python, SQL, Azure, CI/CD, LLM",
  },
  {
    title: "Applikációs funkciófejlesztő gyakornok",
    url: "https://jobs.thyssenkrupp.com/hu/job/Applik%C3%A1ci%C3%B3s-funkci%C3%B3fejleszt%C5%91-gyakornok-Budapest?id=931610",
    company: "thyssenkrupp Components Technology Hungary Kft.",
    location: "Budapest",
    experience: "Diákmunka; nappali tagozatos hallgatói jogviszony szükséges még legalább egy évig",
    technologies: "MATLAB",
  },
  {
    title: "Formal Verification Engineer - New College Graduate",
    url: "https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/Formal-Verification-Engineer---New-College-Graduate_JR2008771",
    company: "NVIDIA",
    location: "Budapest",
    experience: "New College Graduate role",
    technologies: "Perl, Python",
  },
  {
    title: "Junior Backend Engineer - TypeScript",
    url: "https://jobs.cozycozy.com/o/junior-backend-engineer-typescript-budapest",
    company: "cozycozy",
    location: "Budapest",
    experience: "1-2 years of experience",
    technologies: "Node.js, TypeScript, JavaScript, MongoDB, PostgreSQL",
  },
  {
    title: "Manual Tester - Quality Assurance",
    url: "https://jobs.cozycozy.com/o/manual-tester-quality-assurance-budapest",
    company: "cozycozy",
    location: "Budapest",
    experience: "1+ year of experience",
    technologies: "Selenium, iOS, Android",
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

  const jobs = sanitizeJobs(JOBS);
  const [filters, categories] = await Promise.all([loadFilters(), loadCategories()]);

  const client = await pool.connect();
  try {
    const stats = await ingestJobs(client, {
      source: AI_SOURCE,
      jobs,
      fullListing: false,
      filters,
      categories,
    });
    console.log(`[tmp-ai-batch-2026-07-30] clean=${jobs.length} ${JSON.stringify(stats)}`);
    return json(200, { clean: jobs.length, ...stats });
  } catch (err) {
    console.error(`[tmp-ai-batch-2026-07-30] error: ${err.message}`);
    return json(500, { error: "Szerver hiba", details: err.message });
  } finally {
    client.release();
  }
};
