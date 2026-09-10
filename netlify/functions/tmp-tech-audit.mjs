// DISPOSABLE — 2026-09-10. Read-only audit: is technology extraction
// (job_posts.technologies) working correctly per source? Aggregates
// null/empty/has-tech counts and per-source technology-frequency ratios
// (to spot sidebar-pollution / false-positive dominance), plus sample
// titles for any source whose top technology looks suspiciously dominant.
// No writes. Delete after use.
import { Pool } from "pg";
import { load as cheerioLoad } from "cheerio";
import { fetchText, extractTechnologies } from "./_experience_core.mjs";

const TOKEN = "9f2c7b6a1e8d4f05c3a9b7e2d61f804c5a3e9b7d10f6";
const connectionString = process.env.NETLIFY_DATABASE_URL;
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });

  const client = await pool.connect();
  try {
    const url = new URL(request.url);
    if (url.searchParams.get("check") === "profession-elk") {
      const { rows } = await client.query(`
        SELECT
          COUNT(*)::int AS total_elk_or_elt,
          COUNT(*) FILTER (WHERE first_seen >= '2026-09-01')::int AS since_fix_date,
          MIN(first_seen) AS earliest,
          MAX(first_seen) AS latest
        FROM job_posts
        WHERE active = true AND source = 'profession-intern'
          AND (technologies LIKE '%ELK Stack%' OR technologies LIKE '%ELT%')
      `);
      const recent = await client.query(`
        SELECT title, url, technologies, first_seen FROM job_posts
        WHERE active = true AND source = 'profession-intern'
          AND (technologies LIKE '%ELK Stack%' OR technologies LIKE '%ELT%')
          AND first_seen >= '2026-09-01'
        ORDER BY first_seen DESC LIMIT 10
      `);
      return new Response(JSON.stringify({ stats: rows[0], recentRows: recent.rows }, null, 2), {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    if (url.searchParams.get("check") === "elk-source") {
      const target = url.searchParams.get("url");
      const html = await fetchText(target);
      const extracted = extractTechnologies(html);

      const $ = cheerioLoad(html);
      $("script, style, noscript").remove();
      $("li, p, div, br, h1, h2, h3, h4, h5, h6, td, th, tr").each((_, el) => {
        $(el).prepend(" ").append(" ");
      });
      const scoped = $('.description, .job-description, #job-details, .show-more-less-html__markup, [class*="jobDescriptionColumn"], .ContentColumn').first().text().replace(/\s+/g, " ").trim();
      const bodyText = $("body").text().replace(/\s+/g, " ").trim();

      const boundaryRe = (kw) => new RegExp(`(^|[^\\p{L}\\p{N}])${kw}([^\\p{L}\\p{N}]|$|\\d)`, "giu");
      const findHits = (text, kw) => {
        const hits = [];
        const re = boundaryRe(kw);
        let m;
        while ((m = re.exec(text)) && hits.length < 10) {
          const start = Math.max(0, m.index - 40);
          hits.push(text.slice(start, m.index + m[0].length + 40));
          re.lastIndex = m.index + 1;
        }
        return hits;
      };

      return new Response(JSON.stringify({
        extracted,
        scopedTextLength: scoped.length,
        scopedTextSample: scoped.slice(0, 300),
        bodyTextLength: bodyText.length,
        elkHitsInBody: findHits(bodyText, "elk"),
        eltHitsInBody: findHits(bodyText, "elt"),
      }, null, 2), { headers: { "content-type": "application/json; charset=utf-8" } });
    }

    const counts = await client.query(`
      SELECT source,
        COUNT(*)::int AS active_total,
        COUNT(*) FILTER (WHERE technologies IS NULL)::int AS null_count,
        COUNT(*) FILTER (WHERE technologies = '')::int AS empty_count,
        COUNT(*) FILTER (WHERE technologies IS NOT NULL AND technologies <> '')::int AS has_count
      FROM job_posts
      WHERE active = true
      GROUP BY source
      ORDER BY active_total DESC
    `);

    const freq = await client.query(`
      SELECT source, trim(t) AS technology, COUNT(*)::int AS cnt
      FROM job_posts, unnest(string_to_array(technologies, ',')) AS t
      WHERE active = true AND technologies IS NOT NULL AND technologies <> ''
      GROUP BY source, trim(t)
    `);

    const freqBySource = new Map();
    for (const row of freq.rows) {
      if (!freqBySource.has(row.source)) freqBySource.set(row.source, []);
      freqBySource.get(row.source).push(row);
    }

    const out = [];
    for (const c of counts.rows) {
      const techs = (freqBySource.get(c.source) || []).sort((a, b) => b.cnt - a.cnt);
      const top = techs.slice(0, 5).map((t) => ({
        technology: t.technology,
        cnt: t.cnt,
        pct: c.has_count > 0 ? +(t.cnt / c.has_count).toFixed(2) : 0,
      }));
      const suspicious = c.active_total >= 5 && top[0] && top[0].pct >= 0.5;
      out.push({
        source: c.source,
        active_total: c.active_total,
        null_count: c.null_count,
        empty_count: c.empty_count,
        has_count: c.has_count,
        has_pct: c.active_total > 0 ? +(c.has_count / c.active_total).toFixed(2) : 0,
        top_technologies: top,
        suspicious_dominant_tech: suspicious,
      });
    }

    // Sample titles for suspicious sources' dominant technology.
    for (const entry of out) {
      if (!entry.suspicious_dominant_tech) continue;
      const dom = entry.top_technologies[0].technology;
      const { rows } = await client.query(
        `SELECT title, url FROM job_posts
         WHERE active = true AND source = $1 AND technologies LIKE '%' || $2 || '%'
         ORDER BY first_seen DESC LIMIT 6`,
        [entry.source, dom]
      );
      entry.sample_titles_for_dominant = rows;
    }

    // Also sample a few titles for sources with a very low has_pct (< 0.3)
    // despite a decent active_total, to eyeball whether extraction is just
    // not finding real tech or whether the postings genuinely lack it.
    for (const entry of out) {
      if (entry.active_total < 8 || entry.has_pct >= 0.3) continue;
      const { rows } = await client.query(
        `SELECT title, url, technologies FROM job_posts
         WHERE active = true AND source = $1
         ORDER BY first_seen DESC LIMIT 6`,
        [entry.source]
      );
      entry.sample_titles_low_coverage = rows;
    }

    return new Response(JSON.stringify(out, null, 2), {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  } finally {
    client.release();
  }
};
