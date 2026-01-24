import axios from "axios";
import cheerio from "cheerio";
import { Pool } from "pg";

/**
 * Netlify Scheduled Function
 * Runs every day at 04:00 UTC (≈ 05:00 HU winter)
 */
export const config = {
  schedule: "0 4 * * *",
};

const pool = new Pool({
  connectionString: process.env.NETLIFY_DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

export default async () => {
  try {
    console.log("⏰ Job scraper started");

    // TODO: ide jönnek a valós URL-ek
    const res = await axios.get("https://melodiak.hu/");
    const $ = cheerio.load(res.data);

    let found = 0;

    $("a").each(async (_, el) => {
      const title = $(el).text().trim();
      const url = $(el).attr("href");

      if (!title || !url) return;

      found++;

      await pool.query(
        `
        INSERT INTO job_posts (source, title, url)
        VALUES ($1, $2, $3)
        ON CONFLICT (source, url)
        DO UPDATE SET last_seen = NOW()
        `,
        ["melodiak", title, url]
      );
    });

    console.log(`✅ Scrape done, found: ${found}`);

    return new Response(
      JSON.stringify({ ok: true, found }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("❌ Scraper error:", err);
    return new Response(
      JSON.stringify({ ok: false, error: err.message }),
      { status: 500 }
    );
  }
};
