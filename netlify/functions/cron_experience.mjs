export const config = {
  schedule: "17 4-23 * * *",
};

/* =========================
   EXPERIENCE ENRICHMENT (merged cron_jobs 4 + 5 + 12)

   - LinkedIn          → extracts from .description / .show-more-less-html__markup
   - profession-intern → extracts from #box_az-allashoz-tartozo-elvarasok
   - aam, karrierhungaria → extracts from full page body text
   ========================= */

import { Pool } from "pg";
import https from "https";
import http from "http";
import zlib from "zlib";
import { load as cheerioLoad } from "cheerio";

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

const INTERNSHIP_KEYWORDS = [
  "gyakornok", "intern", "internship", "trainee",
  "pályakezdő", "palyakezdo", "diákmunka", "diakmunka",
];
function isInternshipTitle(title) {
  const t = normalizeText(title);
  return INTERNSHIP_KEYWORDS.some(k => t.includes(k));
}

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

function fetchText(url, redirectLeft = 5) {
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
        timeout: 30000,
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
function extractYearsFromText(text) {
  if (!text) return null;

  const patterns = [
    /\b\d+\s?\+\s?(?:év|eves|years?|yrs?)\b/gi,
    /\b\d+\s?(?:[-–]\s?\d+)?\s?(?:év|éves|eves|years?|yrs?)\b/gi,
    /\bminimum\s?\d+\s?(?:év|eves|years?|yrs?)\b/gi,
    /\bat least\s?\d+\s?(?:years?)\b/gi,
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
function extractLinkedInExperience(html) {
  const $ = cheerioLoad(html);
  const description = normalizeWhitespace(
    $(".description, .job-description, #job-details, .show-more-less-html__markup")
      .first()
      .text()
  ) || null;

  return extractYearsFromText(description);
}

// profession-intern: #box_az-allashoz-tartozo-elvarasok
function extractProfessionExperience(html) {
  const $ = cheerioLoad(html);
  const box = $("#box_az-allashoz-tartozo-elvarasok");
  const listText = box.find("ul > li")
    .map((i, el) => normalizeWhitespace($(el).text()))
    .get()
    .join(" ");

  let description = normalizeWhitespace(box.text()) || "";
  description = description ? description + " " + listText : listText || null;

  return extractYearsFromText(description);
}

// aam, karrierhungaria: full body text
function extractBodyExperience(html) {
  const $ = cheerioLoad(html);
  const pageText = normalizeWhitespace($("body").text());
  return extractYearsFromText(pageText);
}

/* ======================
   Pipeline definitions
====================== */
const PIPELINES = [
  {
    label: "LinkedIn",
    sourceFilter: "source = 'LinkedIn'",
    interval: "10 minutes",
    extract: extractLinkedInExperience,
  },
  {
    label: "profession-intern",
    sourceFilter: "source = 'profession-intern'",
    interval: "10 minutes",
    extract: extractProfessionExperience,
  },
  {
    label: "aam / karrierhungaria",
    sourceFilter: "source IN ('aam','karrierhungaria')",
    interval: "10 minutes",
    extract: extractBodyExperience,
  },
];

/* ======================
   MAIN
====================== */
export default async () => {
  console.log("=== EXPERIENCE ENRICHMENT STARTED ===");
  const client = await pool.connect();

  try {
    for (const pipe of PIPELINES) {
      const { rows } = await client.query(
        `SELECT id, url, title
         FROM job_posts
         WHERE first_seen >= NOW() - INTERVAL '${pipe.interval}'
           AND (experience IS NULL OR experience = '-')
           AND ${pipe.sourceFilter}
         ORDER BY first_seen DESC
         LIMIT 300`
      );

      console.log(`[${pipe.label}] ${rows.length} rows to enrich`);

      let success = 0;
      let failed = 0;

      for (const row of rows) {
        try {
          const html = await fetchText(row.url);
          let experience = pipe.extract(html);

          if (isInternshipTitle(row.title)) experience = "diákmunka";

          await client.query(
            `UPDATE job_posts SET experience = $1 WHERE id = $2`,
            [experience || "-", row.id]
          );

          success++;
          await sleep(250);
        } catch (err) {
          console.error(`[${pipe.label}] FAILED ID:`, row.id, "|", err.message);
          failed++;
        }
      }

      console.log(`[${pipe.label}] done — success: ${success}, failed: ${failed}`);
    }
  } finally {
    client.release();
  }

  console.log("=== EXPERIENCE ENRICHMENT FINISHED ===");
  return new Response("OK");
};
