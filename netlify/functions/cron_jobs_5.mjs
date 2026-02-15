export const config = {
  schedule: "15 4-22/3 * * *", // az eredeti cron
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
        stream.on("end", () => resolve(data));
        stream.on("error", reject);
      }
    );

    req.on("error", reject);
    req.end();
  });
}

/* ======================
   Profession Extraction
====================== */
function extractProfession(html) {
  const $ = cheerioLoad(html);

  const profession =
    normalizeWhitespace(
      $(".profession, .job-profession, #job-profession, .job-category")
        .first()
        .text()
    ) || null;

  console.log("Extracted Profession:", profession ?? "NOT FOUND");

  return { profession };
}

/* ======================
   MAIN WORKER
====================== */
export default async () => {
  console.log("=== PROFESSION ENRICHMENT STARTED ===");

  const client = await pool.connect();

  try {
       const { rows } = await client.query(`
  SELECT id, url
  FROM job_posts
  WHERE first_seen >= NOW() - INTERVAL '30 minutes'
    AND (experience IS NULL OR experience = '-')
    AND source = 'profession-intern'
  ORDER BY first_seen DESC;
`);

    console.log("Jobs to process:", rows.length);

    let success = 0;
    let failed = 0;

    for (const row of rows) {
      console.log(`Processing ID: ${row.id} | URL: ${row.url}`);

      try {
        const html = await fetchText(row.url);
        const details = extractProfession(html);

        await client.query(
          `UPDATE job_posts SET profession = $1 WHERE id = $2`,
          [details.profession ?? "-", row.id]
        );

        console.log(`✅ Updated ID: ${row.id} with profession: ${details.profession ?? "-"}`);
        success++;
        await sleep(250); // enyhe rate-limit
      } catch (err) {
        console.error(`❌ FAILED ID: ${row.id} | ${err.message}`);
        failed++;
      }
    }

    console.log("=== SUMMARY ===");
    console.log("Success:", success);
    console.log("Failed:", failed);

  } finally {
    client.release();
  }

  console.log("=== PROFESSION ENRICHMENT FINISHED ===");

  return new Response("OK");
};
