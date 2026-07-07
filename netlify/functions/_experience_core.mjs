/* =========================
   EXPERIENCE EXTRACTION — shared core
   Per-source extractors + generic enrichment helper.
   Used by source cron files (cron_jobs_*-background.mjs) and
   by cron_experience-background.mjs for LinkedIn.
   ========================= */

import { Pool } from "pg";
import https from "https";
import http from "http";
import zlib from "zlib";
import { load as cheerioLoad } from "cheerio";
import { logFetchError } from "./_error-logger.mjs";

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL missing");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

/* ======================
   Helpers
====================== */
function normalizeWhitespace(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

function normalizeText(s) {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export const INTERNSHIP_KEYWORDS = [
  "gyakornok", "intern", "internship", "trainee",
  "pályakezdő", "palyakezdo", "diákmunka", "diakmunka",
  "tehetsegprogram", "tehetségprogram", "talent",  "graduate", "student", "students", "early career",
];

export const JUNIOR_KEYWORDS = [
  "junior",
];

export const MID_KEYWORDS = [
  "medior", "mid-level", "mid level",
];

export function isInternshipTitle(title) {
  const t = normalizeText(title);
  return INTERNSHIP_KEYWORDS.some(k => t.includes(k));
}

export function isJuniorTitle(title) {
  const t = normalizeText(title);
  return JUNIOR_KEYWORDS.some(k => t.includes(k));
}

export function isMidLevelTitle(title) {
  const t = normalizeText(title);
  return MID_KEYWORDS.some(k => t.includes(k));
}

// Sources that are inherently student/intern focused
export const INTERN_SOURCES = [
  "minddiak", "muisz", "zyntern", "schonherz",
  "tudasdiak", "tudatosdiak", "ydiak", "qdiak", "miszisz",
];

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/* ======================
   Fetch
====================== */
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/121.0.0.0 Safari/537.36";

export function fetchText(url, redirectLeft = 5) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;

    const req = lib.request(
      u,
      {
        method: "GET",
        headers: {
          "User-Agent": UA,
          Accept: "text/html,application/xhtml+xml,*/*",
          "Accept-Language": "hu-HU,hu;q=0.9,en;q=0.8",
          "Accept-Encoding": "gzip,deflate,br",
        },
        timeout: 25000,
      },
      (res) => {
        const code = res.statusCode || 0;

        if ([301, 302, 303, 307, 308].includes(code)) {
          const loc = res.headers.location;
          if (!loc) return reject(new Error(`HTTP ${code} (no Location) for ${url}`));
          if (redirectLeft <= 0) return reject(new Error(`Too many redirects for ${url}`));
          const nextUrl = new URL(loc, url).toString();
          res.resume();
          return resolve(fetchText(nextUrl, redirectLeft - 1));
        }

        const enc = String(res.headers["content-encoding"] || "").toLowerCase();
        let stream = res;
        if (enc.includes("gzip")) stream = res.pipe(zlib.createGunzip());
        else if (enc.includes("deflate")) stream = res.pipe(zlib.createInflate());
        else if (enc.includes("br")) stream = res.pipe(zlib.createBrotliDecompress());

        let data = "";
        stream.setEncoding("utf8");
        stream.on("data", c => data += c);
        stream.on("end", () => {
          if (code >= 200 && code < 300) resolve(data);
          else reject(new Error(`HTTP ${code} for ${url}`));
        });
        stream.on("error", reject);
      }
    );

    req.on("timeout", () => req.destroy(new Error(`Timeout for ${url}`)));
    req.on("error", reject);
    req.end();
  });
}

/* ======================
   Experience regex (shared)
====================== */
export function extractYearsFromText(text) {
  if (!text) return null;

  const patterns = [
    /\b\d+\s?\+\s?(?:év|eves|years?|yrs?)\b/gi,
    /\b\d+\s?(?:[-–]\s?\d+)?\s?(?:év|éves|eves|years?|yrs?)\b/gi,
    /\bminimum\s?\d+\s?(?:év|eves|years?|yrs?)\b/gi,
    /\bat least\s?\d+\s?(?:years?)\b/gi,
    /\blegalabb\s+\d+\s?(?:ev|eves|year)\b/gi,
    /\btobb\s?eves\b/gi,
    /\bseveral\s?years?\b/gi,
  ];

  const matches = [];
  for (const regex of patterns) {
    const found = text.match(regex);
    if (found) matches.push(...found);
  }

  if (!matches.length) return null;

  const maxReasonable = 15;
  const filtered = matches.filter(m => {
    const nums = m.match(/\d+/g)?.map(n => parseInt(n, 10)) || [];
    return nums.every(n => n <= maxReasonable);
  });

  if (!filtered.length) return null;

  return [...new Set(
    filtered.map(m => m.replace(/\s+/g, " ").trim().toLowerCase())
  )].join(", ");
}

/* ======================
   Source-specific extractors
====================== */

// LinkedIn: .description / .show-more-less-html__markup
export function extractLinkedInExperience(html) {
  const $ = cheerioLoad(html);
  const description = normalizeWhitespace(
    $(".description, .job-description, #job-details, .show-more-less-html__markup")
      .first()
      .text()
  ) || null;

  return extractYearsFromText(description);
}

// profession-intern: #box_az-allashoz-tartozo-elvarasok, with body fallback
export function extractProfessionExperience(html) {
  const $ = cheerioLoad(html);
  const box = $("#box_az-allashoz-tartozo-elvarasok");
  const listText = box.find("ul > li")
    .map((i, el) => normalizeWhitespace($(el).text()))
    .get()
    .join(" ");

  let description = normalizeWhitespace(box.text()) || "";
  description = description ? description + " " + listText : listText || null;

  const fromBox = extractYearsFromText(description);
  if (fromBox) return fromBox;

  // Fallback: full body scan (handles English-language jobs, variant layouts)
  const pageText = normalizeWhitespace($("body").text());
  return extractYearsFromText(pageText);
}

// aam, karrierhungaria, cvcentrum, dreamjobs, melonjobs: full body text
export function extractBodyExperience(html) {
  const $ = cheerioLoad(html);
  // Insert spaces between block elements so adjacent <li>/<p>/<div> texts
  // don't get concatenated (e.g. "végzettség3 év" → no \b before digit).
  $("li, p, div, br, h1, h2, h3, h4, h5, h6, td, th, tr").each((_, el) => {
    $(el).prepend(" ").append(" ");
  });
  const pageText = normalizeWhitespace($("body").text());
  return extractYearsFromText(pageText);
}

// bluebird.hu: Thrive builderes oldal — a hirdetés szövege a
// section.tcb-post-content-ben van; a body-fallback azért biztonságos, mert a
// céges boilerplate ("több mint 20 éves tapasztalattal") a 15 éves
// plauzibilitási plafonon fennakad.
export function extractBluebirdExperience(html) {
  const $ = cheerioLoad(html);
  $("li, p, div, br, h1, h2, h3, h4, h5, h6, td, th, tr").each((_, el) => {
    $(el).prepend(" ").append(" ");
  });
  const scoped = normalizeWhitespace($("section.tcb-post-content").text());
  if (scoped) {
    const fromScoped = extractYearsFromText(scoped);
    if (fromScoped) return fromScoped;
  }
  return extractYearsFromText(normalizeWhitespace($("body").text()));
}

// talent.com: Next.js SSR — description is in __NEXT_DATA__ JSON, not in visible body text
export function extractTalentExperience(html) {
  // 1. Try __NEXT_DATA__ (Next.js SSR blob)
  const nextDataMatch = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (nextDataMatch) {
    try {
      const data = JSON.parse(nextDataMatch[1]);
      // talent.com puts job description in props.pageProps.job.description or similar
      const jobStr = JSON.stringify(data?.props?.pageProps ?? data);
      const result = extractYearsFromText(jobStr);
      if (result) return result;
    } catch {
      // ignore JSON parse errors
    }
  }

  // 2. Try JSON-LD structured data
  const jsonLdMatches = html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
  for (const m of jsonLdMatches) {
    try {
      const obj = JSON.parse(m[1]);
      const text = JSON.stringify(obj);
      const result = extractYearsFromText(text);
      if (result) return result;
    } catch {
      // ignore
    }
  }

  // 3. Fallback: body text (for cases where SSR did render content)
  const $ = cheerioLoad(html);
  return extractYearsFromText(normalizeWhitespace($("body").text()));
}

// kuka: "What you need to succeed" section
export function extractKukaExperience(html) {
  const idx = html.indexOf("What you need to succeed");
  if (idx === -1) return extractBodyExperience(html);
  const section = html.substring(idx, idx + 3000);
  const $ = cheerioLoad(section);
  return extractYearsFromText($.text());
}

/* ======================
   Technology keyword extraction — shared core
   Runs on the SAME html a source already fetched for experience, no extra
   fetch. Curated for junior/entry-level programming job ads: languages,
   web/backend frameworks, databases, cloud/devops, tools, data/AI, mobile.
   Very short/ambiguous tokens that collide with ordinary English/Hungarian
   words (bare "r", bare "go") are intentionally left out to keep false
   positives low.
====================== */
export const TECH_KEYWORDS = [
  // languages
  ["javascript", "JavaScript"], ["typescript", "TypeScript"], ["python", "Python"],
  ["java", "Java"], ["c++", "C++"], ["c#", "C#"], ["golang", "Go"], ["kotlin", "Kotlin"],
  ["swift", "Swift"], ["php", "PHP"], ["ruby", "Ruby"], ["scala", "Scala"], ["rust", "Rust"],
  ["matlab", "MATLAB"], ["perl", "Perl"], ["sql", "SQL"], ["pl/sql", "PL/SQL"], ["bash", "Bash"],
  ["objective-c", "Objective-C"], ["dart", "Dart"], ["elixir", "Elixir"], ["haskell", "Haskell"],
  ["vba", "VBA"], ["abap", "ABAP"], ["cobol", "COBOL"], ["groovy", "Groovy"],

  // web / frontend
  ["html", "HTML"], ["css", "CSS"], ["sass", "Sass"], ["scss", "SCSS"], ["react", "React"],
  ["react native", "React Native"], ["angular", "Angular"], ["vue", "Vue"], ["svelte", "Svelte"],
  ["next.js", "Next.js"], ["nuxt", "Nuxt"], ["jquery", "jQuery"], ["webpack", "Webpack"],
  ["vite", "Vite"], ["tailwind", "Tailwind"], ["bootstrap", "Bootstrap"],

  // backend / frameworks
  ["node.js", "Node.js"], ["nodejs", "Node.js"], ["express", "Express"], ["nestjs", "NestJS"],
  [".net", ".NET"], ["asp.net", "ASP.NET"], ["spring boot", "Spring Boot"], ["spring", "Spring"],
  ["django", "Django"], ["flask", "Flask"], ["fastapi", "FastAPI"], ["laravel", "Laravel"],
  ["symfony", "Symfony"], ["rails", "Ruby on Rails"], ["hibernate", "Hibernate"],

  // data / databases
  ["postgresql", "PostgreSQL"], ["postgres", "PostgreSQL"], ["mysql", "MySQL"],
  ["mssql", "MSSQL"], ["sql server", "SQL Server"], ["oracle", "Oracle"], ["mongodb", "MongoDB"],
  ["redis", "Redis"], ["elasticsearch", "Elasticsearch"], ["cassandra", "Cassandra"],
  ["sqlite", "SQLite"], ["dynamodb", "DynamoDB"], ["snowflake", "Snowflake"],
  ["power bi", "Power BI"], ["tableau", "Tableau"], ["spark", "Spark"], ["hadoop", "Hadoop"],
  ["kafka", "Kafka"], ["rabbitmq", "RabbitMQ"], ["airflow", "Airflow"],

  // cloud / devops
  ["aws", "AWS"], ["azure", "Azure"], ["gcp", "GCP"], ["google cloud", "Google Cloud"],
  ["docker", "Docker"], ["kubernetes", "Kubernetes"], ["terraform", "Terraform"],
  ["ansible", "Ansible"], ["jenkins", "Jenkins"], ["gitlab ci", "GitLab CI"],
  ["github actions", "GitHub Actions"], ["ci/cd", "CI/CD"], ["linux", "Linux"],
  ["nginx", "Nginx"], ["microservices", "Microservices"],

  // tools / practices
  ["git", "Git"], ["jira", "Jira"], ["confluence", "Confluence"], ["figma", "Figma"],
  ["rest api", "REST API"], ["graphql", "GraphQL"], ["grpc", "gRPC"], ["soap", "SOAP"],
  ["agile", "Agile"], ["scrum", "Scrum"], ["kanban", "Kanban"], ["tdd", "TDD"],
  ["unit test", "Unit Test"], ["junit", "JUnit"], ["selenium", "Selenium"],
  ["cypress", "Cypress"], ["jest", "Jest"],

  // data / AI
  ["machine learning", "Machine Learning"], ["deep learning", "Deep Learning"],
  ["tensorflow", "TensorFlow"], ["pytorch", "PyTorch"], ["pandas", "Pandas"],
  ["numpy", "NumPy"], ["scikit-learn", "scikit-learn"], ["nlp", "NLP"], ["llm", "LLM"],
  ["opencv", "OpenCV"],

  // mobile
  ["android", "Android"], ["ios", "iOS"], ["flutter", "Flutter"], ["xamarin", "Xamarin"],
];

function techBoundaryRegex(keyword) {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i");
}

// Extracts a comma-joined list of recognized technology keywords from an
// already-fetched job detail page — piggybacks on whatever html a source
// fetched for extractBodyExperience/etc, no extra network call.
export function extractTechnologies(html) {
  const $ = cheerioLoad(html);
  $("li, p, div, br, h1, h2, h3, h4, h5, h6, td, th, tr").each((_, el) => {
    $(el).prepend(" ").append(" ");
  });
  let text = normalizeWhitespace($("body").text());

  // JS-rendered pages (e.g. talent.com) keep the description in a data blob
  // instead of visible DOM text — scan those too, still zero extra fetches.
  const nextDataMatch = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (nextDataMatch) text += " " + nextDataMatch[1];
  for (const m of html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    text += " " + m[1];
  }

  const found = new Set();
  for (const [key, label] of TECH_KEYWORDS) {
    if (techBoundaryRegex(key).test(text)) found.add(label);
  }
  return found.size ? [...found].join(", ") : null;
}

// Ensure the column exists at most once per warm container (mirrors
// _active_core.mjs's ensureActiveSchema for the `active` column).
let _techSchemaReady = false;
export async function ensureTechnologiesColumn(client) {
  if (_techSchemaReady) return;
  await client.query(`ALTER TABLE job_posts ADD COLUMN IF NOT EXISTS technologies text`);
  _techSchemaReady = true;
}

/* ======================
   Generic enrichment
====================== */
/**
 * Enrich job_posts.experience by fetching each job URL and applying an extractor.
 *
 * @param {object} opts
 * @param {string} opts.sourceFilter  - SQL fragment, e.g. "source = 'kuka'"
 * @param {(html:string) => string|null} opts.extract
 * @param {string} [opts.label]       - log label
 * @param {string} [opts.jobName]     - cron job name (for error logging)
 * @param {number} [opts.intervalMinutes=30]
 * @param {number} [opts.limit=300]
 * @param {string[]} [opts.extraInternKeywords]
 * @param {string} [opts.experienceCondition] - default "(experience IS NULL OR experience = '-')"
 * @param {number} [opts.sleepMs=250]
 */
export async function enrichExperience({
  sourceFilter,
  extract,
  label,
  jobName,
  intervalMinutes = 30,
  limit = 300,
  extraInternKeywords,
  experienceCondition = "(experience IS NULL OR experience = '-')",
  sleepMs = 250,
}) {
  const tag = label || sourceFilter;
  const job = jobName || "experience-enrich";
  const client = await pool.connect();

  try {
    await ensureTechnologiesColumn(client);

    const { rows } = await client.query(
      `SELECT id, url, title
         FROM job_posts
        WHERE first_seen >= NOW() - INTERVAL '${intervalMinutes} minutes'
          AND ${experienceCondition}
          AND ${sourceFilter}
        ORDER BY first_seen DESC
        LIMIT ${limit}`
    );

    console.log(`[experience:${tag}] ${rows.length} rows to enrich`);

    let success = 0;
    let failed = 0;

    for (const row of rows) {
      try {
        const html = await fetchText(row.url);
        let experience = extract(html);
        const technologies = extractTechnologies(html);

        // Title always overrides (highest priority)
        if (
          isInternshipTitle(row.title) ||
          extraInternKeywords?.some(k => normalizeText(row.title).includes(k))
        ) {
          experience = "diákmunka";
        } else if (isJuniorTitle(row.title)) {
          experience = "junior";
        } else if (isMidLevelTitle(row.title)) {
          experience = "medior";
        }

        await client.query(
          `UPDATE job_posts SET experience = $1, technologies = COALESCE($3, technologies) WHERE id = $2`,
          [experience || "-", row.id, technologies]
        );

        success++;
        await sleep(sleepMs);
      } catch (err) {
        await logFetchError(job, {
          url: row.url,
          message: err.message,
          extra: { source: tag, jobId: row.id },
        });
        console.error(`[experience:${tag}] FAILED ID:`, row.id, "|", err.message);

        const fallback = (
          isInternshipTitle(row.title) || extraInternKeywords?.some(k => normalizeText(row.title).includes(k))
        ) ? "diákmunka"
          : isJuniorTitle(row.title) ? "junior"
          : isMidLevelTitle(row.title) ? "medior"
          : "-";

        await client.query(
          `UPDATE job_posts SET experience = $1 WHERE id = $2`,
          [fallback, row.id]
        );

        failed++;
      }
    }

    console.log(`[experience:${tag}] done — success: ${success}, failed: ${failed}`);
    return { success, failed, total: rows.length };
  } finally {
    client.release();
  }
}
