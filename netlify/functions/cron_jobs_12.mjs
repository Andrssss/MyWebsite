export const config = {
  schedule: "2 4-23 * * *",
};

/* ========================= GETTING EXPERIENCE LEVEL
const ENRICH_SOURCES = ["aam", "karrierhungaria"];
--------------------- */

import { Pool } from "pg";
import https from "https";
import http from "http";
import zlib from "zlib";
import { load as cheerioLoad } from "cheerio";

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

const ENRICH_SOURCES = ["aam", "karrierhungaria"];

function normalizeWhitespace(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fetchText(url, redirectLeft = 5) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;

    const req = lib.request(
      u,
      {
        method: "GET",
        headers: {
          "User-Agent": "JobWatcher/1.0",
          Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
          "Accept-Language": "hu-HU,hu;q=0.9,en;q=0.8",
          "Accept-Encoding": "gzip,deflate,br",
        },
        timeout: 50000,
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
        stream.on("data", (chunk) => (data += chunk));
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

function extractExperienceFromHtml(html) {
  const $ = cheerioLoad(html);
  const pageText = normalizeWhitespace($("body").text());
  if (!pageText) return null;

  const patterns = [
    /\b\d+\s?\+\s?(?:ev|eves|ev|eves|years?|yrs?)\b/gi,
    /\b\d+\s?(?:-\s?\d+)?\s?(?:ev|eves|ev|eves|years?|yrs?)\b/gi,
    /\bminimum\s?\d+\s?(?:ev|eves|ev|eves|years?|yrs?)\b/gi,
    /\bat least\s?\d+\s?(?:years?)\b/gi,
  ];

  const matches = [];
  for (const regex of patterns) {
    const found = pageText.match(regex);
    if (found) matches.push(...found);
  }

  if (!matches.length) return null;

  const maxReasonable = 15;
  const filtered = matches.filter((m) => {
    const nums = m.match(/\d+/g)?.map((n) => parseInt(n, 10)) || [];
    return nums.every((n) => n <= maxReasonable);
  });

  if (!filtered.length) return null;

  return [...new Set(filtered.map((m) => m.replace(/\s+/g, " ").trim().toLowerCase()))].join(", ");
}

export default async () => {
  const client = await pool.connect();

  try {
    const { rows: enrichRows } = await client.query(
      `SELECT id, url
       FROM job_posts
       WHERE first_seen >= NOW() - INTERVAL '10 minutes'
         AND (experience IS NULL OR experience = '-')
         AND source = ANY($1::text[])
       ORDER BY first_seen DESC
       LIMIT 300`,
      [ENRICH_SOURCES]
    );

    for (const row of enrichRows) {
      try {
        const detailHtml = await fetchText(row.url);
        const experience = extractExperienceFromHtml(detailHtml);

        if (experience) {
          await client.query(
            `UPDATE job_posts
             SET experience = $1
             WHERE id = $2`,
            [experience, row.id]
          );
        }

        await sleep(200);
      } catch (err) {
        console.error("enrichment failed:", row.id, err.message);
      }
    }
  } finally {
    client.release();
  }

  return new Response("OK");
};
