export const config = {
  schedule: "5 4-22/3 * * *", // az eredeti cron
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

function extractRequirements(html) {
  const $ = cheerioLoad(html);

  // A box, ahol az elvárások vannak
  const requirementsBox = $("#box_az-allashoz-tartozo-elvarasok");

  // Kinyerjük az összes <li> elemet
  const requirements = requirementsBox.find("ul > li")
    .map((i, el) => normalizeWhitespace($(el).text()))
    .get(); // .get() visszaadja arrayként

  console.log("Requirements found:", requirements.length ? requirements : "NOT FOUND");

  return { requirements };
}


/* ======================
   Profession Extraction
====================== */
function extractProfession(html) {
  const $ = cheerioLoad(html);

  // Kinyerjük a profession-t a szelektorokból
  const profession =
    normalizeWhitespace(
        $("h1.job-title, h1").first().text()
    ) || null;


  // Kinyerjük a teljes leírást a debughoz (pl. .description vagy #job-details)
  const description =
    normalizeWhitespace(
      $(".description, .job-description, #job-details, .show-more-less-html__markup")
        .first()
        .text()
    ) || null;

  console.log("Extracted Profession:", profession ?? "NOT FOUND");
  console.log("Description found:", description ?? "NOT FOUND");

  return { profession, description };
}
function extractJobDetails(html) {
  const $ = cheerioLoad(html);

  // Grab description from box and combine all <li> items
  const box = $("#box_az-allashoz-tartozo-elvarasok");
  const listText = box.find("ul > li")
    .map((i, el) => normalizeWhitespace($(el).text()))
    .get()
    .join(" ");

  let description = normalizeWhitespace(box.text()) || "";
  description = description ? description + " " + listText : listText || null;

  // Extract experience from description and <li> combined
  let experience = null;
  if (description) {
    const patterns = [
      /\b\d+\s?\+\s?(?:év|years?)\b/gi,
      /\b\d+\s?(?:[-–]\s?\d+)?\s?(?:év|éves|years?|yrs?)\b/gi,
      /\bminimum\s?\d+\s?(?:év|years?)\b/gi,
      /\bat least\s?\d+\s?(?:years?)\b/gi
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
  console.log("Description snippet:", description?.slice(0, 120) ?? "NOT FOUND");

  return { description, experience };
}

function extractProfession(html) {
  const $ = cheerioLoad(html);

  // Better profession extraction for profession.hu
  let profession =
    normalizeWhitespace(
      $("h1.job-title").first().text()
    ) || normalizeWhitespace($("h1").first().text()) || null;

  // Fallback: sometimes profession is in breadcrumb or meta
  if (!profession) {
    profession =
      normalizeWhitespace($(".breadcrumb li").last().text()) ||
      normalizeWhitespace($("meta[name='keywords']").attr("content")) ||
      null;
  }

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
        WHERE first_seen >= NOW() - INTERVAL '3 days'
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

        // Extract both profession and requirements
        const professionDetails = extractProfession(html);
        const jobDetails = extractJobDetails(html); // <-- this gets experience via regex

        // Merge all info
        const details = { ...professionDetails, ...jobDetails };

        // Use the extracted experience
        await client.query(
        `
        UPDATE job_posts
        SET experience = $1
        WHERE id = $2
        `,
        [details.experience || "-", row.id]
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
