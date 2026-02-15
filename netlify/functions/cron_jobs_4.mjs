export const config = {
  schedule: "15 4-22/3 * * *",
};

import { Pool } from "pg";
import https from "https";
import http from "http";
import zlib from "zlib";
import { load as cheerioLoad } from "cheerio";

/* ======================
   DB
====================== */

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

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;


    const req = lib.request(
      u,
      {
        headers: {
          "User-Agent": UA,
          Accept: "text/html,application/xhtml+xml,*/*",
          "Accept-Encoding": "gzip,deflate,br"
        },
        timeout: 30000
      },
      (res) => {

        const code = res.statusCode || 0;

        if (code >= 300 && code < 400 && res.headers.location) {
          const redirectUrl = new URL(res.headers.location, url).toString();
          console.log("Redirect →", redirectUrl);
          return resolve(fetchText(redirectUrl));
        }

        let stream = res;
        const enc = String(res.headers["content-encoding"] || "").toLowerCase();

        if (enc.includes("gzip")) stream = res.pipe(zlib.createGunzip());
        else if (enc.includes("deflate")) stream = res.pipe(zlib.createInflate());
        else if (enc.includes("br")) stream = res.pipe(zlib.createBrotliDecompress());

        let data = "";
        stream.setEncoding("utf8");
        stream.on("data", c => data += c);
        stream.on("end", () => {
          resolve(data);
        });
        stream.on("error", reject);
      }
    );

    req.on("error", reject);
    req.end();
  });
}

/* ======================
   YOUR EXPERIENCE EXTRACTION
====================== */

function extractJobDetails(html) {
  const $ = cheerioLoad(html);

  const description =
    normalizeWhitespace(
      $(".description, .job-description, #job-details, .show-more-less-html__markup")
        .first()
        .text()
    ) || null;

  let experience = null;

  if (description) {
    const patterns = [
      /(\d+\s?\+\s?(?:év|years?))/gi,
      /(\d+\s?(?:[-–]\s?\d+)?\s?(?:év|éves|years?|yrs?))/gi,
      /(minimum\s?\d+\s?(?:év|years?))/gi,
      /(at least\s?\d+\s?(?:years?))/gi
    ];

    const matches = [];

    for (const regex of patterns) {
      const found = description.match(regex);
      if (found) matches.push(...found);
    }

    if (matches.length) {
      const maxReasonable = 15;

      const filtered = matches.filter(m => {
        const nums = m.match(/\d+/g)?.map(n => parseInt(n, 10)) || [];
        return nums.every(n => n <= maxReasonable);
      });

      if (filtered.length) {
        experience = [...new Set(
          filtered.map(m => m.replace(/\s+/g, ' ').trim().toLowerCase())
        )].join(", ");
      }
    }
  }

  console.log("Extracted Experience:", experience ?? "NOT FOUND");

  return { description, experience };
}

/* ======================
   MAIN WORKER
====================== */

export default async () => {

  console.log("=== ENRICHMENT WORKER STARTED ===");
  console.log("Time:", new Date().toISOString());

  const client = await pool.connect();

  try {

    const { rows } = await client.query(`
    SELECT id, url
    FROM job_posts
    WHERE first_seen >= NOW() - INTERVAL '4 day'
        AND first_seen < NOW() - INTERVAL '3 day'
        AND (experience IS NULL OR experience = '-')
    ORDER BY first_seen DESC
    `);


    console.log("Jobs to process:", rows.length);

    let success = 0;
    let failed = 0;

    for (const row of rows) {

      console.log("--------------------------------------");
      console.log("Processing ID:", row.id);
      console.log("URL:", row.url);

      try {

        const html = await fetchText(row.url);
        const details = extractJobDetails(html);

        await client.query(
            `
            UPDATE job_posts
            SET experience = $1
            WHERE id = $2
            `,
            [
                details.experience ?? "-",
                row.id
            ]
            );

        success++;
        await sleep(250);

      } catch (err) {
        console.error("FAILED ID:", row.id, "|", err.message);
        failed++;
      }
    }

    console.log("=== SUMMARY ===");
    console.log("Success:", success);
    console.log("Failed:", failed);

  } finally {
    client.release();
  }

  console.log("=== ENRICHMENT WORKER FINISHED ===");

  return new Response("OK");
};
