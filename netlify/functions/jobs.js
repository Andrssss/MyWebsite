// netlify/functions/jobs.js
const { Pool } = require("pg");

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) {
  console.error("❌ NETLIFY_DATABASE_URL nincs beállítva.");
  throw new Error("NETLIFY_DATABASE_URL environment variable is not set.");
}

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

function jsonResponse(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}

// FIXED lista (key/label/url)
const FIXED = [
  { key: "minddiak", label: "Minddiák", url: "https://minddiak.hu/position?page=2" },
  { key: "muisz", label: "Muisz", url: "https://muisz.hu/hu/diakmunkaink?categories=3&locations=10" },
  { key: "cvcentrum-gyakornok-it", label: "CV Centrum", url: "https://cvcentrum.hu/allasok/?s=gyakornok&category%5B%5D=it&category%5B%5D=it-programozas&category%5B%5D=it-uzemeltetes&type=&location%5B%5D=budapest&_noo_job_field_year_experience=&post_type=noo_job" },
  { key: "cvcentrum-intern-it", label: "CV Centrum", url: "https://cvcentrum.hu/?s=intern&category%5B%5D=information-technology&category%5B%5D=it&category%5B%5D=it-programozas&category%5B%5D=it-uzemeltetes&category%5B%5D=networking&type=&_noo_job_field_year_experience=&post_type=noo_job" },
  { key: "zyntern", label: "Zyntern", url: "https://zyntern.com/jobs?fields=16" },
  { key: "profession-intern", label: "Profession – Intern", url: "https://www.profession.hu/allasok/it-programozas-fejlesztes/budapest/1,10,23,intern" },
  { key: "profession-gyakornok", label: "Profession – Gyakornok", url: "https://www.profession.hu/allasok/it-uzemeltetes-telekommunikacio/budapest/1,25,23,gyakornok" },
  { key: "schonherz", label: "Schönherz – Budapest", url: "https://schonherz.hu/diakmunkak/budapest/fejleszto---tesztelo" },
  { key: "tudasdiak", label: "Tudasdiak", url: "https://tudatosdiak.anyway.hu/hu/jobs?searchIndustry%5B%5D=7&searchMinHourlyWage=1000" },
  { key: "profession-junior", label: "Profession – junior", url: "https://www.profession.hu/allasok/tesztelo-tesztmernok/budapest/1,10,23,0,80" },
  { key: "otp", label: "OTP", url: "https://karrier.otpbank.hu/go/Minden-allasajanlat/1167001/?q=&q2=&alertId=&locationsearch=&title=GYAKORNOK&date=&location=&shifttype=" },
  { key: "vizmuvek",  label:  "vizmuvek", url: "https://www.vizmuvek.hu/hu/karrier/gyakornoki-dualis-kepzes" },
  { key: "LinkedIn",label: "LinkedIn PAST 24H", url: "https://www.linkedin.com/jobs/search/?currentJobId=4194029806&f_E=1%2C2&f_TPR=r86400&geoId=100288700&origin=JOB_SEARCH_PAGE_JOB_FILTER&refresh=true&sortBy=R" },
  { key: "cvonline",  label:  "cvonline", url: "https://www.cvonline.hu/hu/allashirdetesek/it-informatika-0/budapest/apprenticeships?search=&job_geo_location=&radius=25&%C3%81ll%C3%A1skeres%C3%A9s=%C3%81ll%C3%A1skeres%C3%A9s&lat=&lon=&country=&administrative_area_level_1=" },
  { key: "wherewework", label: "wherewework", url: "https://www.wherewework.hu/en/jobs/budaors,budapest/bpo-services,health-services,other-services,others,pharmaceutical,horeca,itc,trade,agriculture,education" },
   { key: "onejob", label: "onejob", url: "https://onejob.hu/munkaink/?job__category_spec=informatika&job__location_spec=budapest" },
];

exports.handler = async (event) => {
  const client = await pool.connect();
  try {
    const method = event.httpMethod;
    const path = event.path || "";
    const parts = path.split("/");
    const maybeId = parts[parts.length - 1];
    const id = /^\d+$/.test(maybeId) ? parseInt(maybeId, 10) : null;

    if (method === "OPTIONS") {
      return {
        statusCode: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,DELETE,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
        body: "",
      };
    }

    if (method === "GET") {
      const qs = event.queryStringParameters || {};
      const source = qs.source || null;
      const limit = Math.min(parseInt(qs.limit || "500", 10) || 500, 1000);

      // GET /jobs/sources
      if (path.endsWith("/jobs/sources") || path.endsWith("/jobs/sources/")) {
        const { rows } = await client.query(`
          SELECT source AS key,
                 COUNT(*)::int AS count
          FROM job_posts
          GROUP BY source
        `);

        const map = new Map(rows.map((r) => [r.key, r]));
        const out = FIXED.map((s) => ({
          key: s.key,
          label: s.label,
          url: s.url,
          count: map.get(s.key)?.count ?? 0,
        }));

        return jsonResponse(200, out);
      }

      // GET /jobs/:id
      if (id) {
        const { rows } = await client.query(
          `SELECT id, source, title, url, description,
                  first_seen AS "firstSeen"
           FROM job_posts
           WHERE id = $1`,
          [id]
        );
        if (rows.length === 0) return jsonResponse(404, { error: "Nem található." });
        return jsonResponse(200, rows[0]);
      }

      // GET /jobs?source=...
      if (source) {
        const { rows } = await client.query(
          `SELECT id, source, title, url, description,
                  first_seen AS "firstSeen"
           FROM job_posts
           WHERE source = $1
           ORDER BY first_seen DESC, id DESC
           LIMIT $2`,
          [source, limit]
        );
        return jsonResponse(200, rows);
      }

      // GET /jobs
      const { rows } = await client.query(
        `SELECT id, source, title, url, description,
                first_seen AS "firstSeen"
         FROM job_posts
         ORDER BY first_seen DESC, id DESC
         LIMIT $1`,
        [limit]
      );
      return jsonResponse(200, rows);
    }

    if (method === "DELETE" && id) {
      const { rowCount } = await client.query(`DELETE FROM job_posts WHERE id = $1`, [id]);
      if (rowCount === 0) return jsonResponse(404, { error: "Nincs ilyen id." });

      return {
        statusCode: 204,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
        },
        body: "",
      };
    }

    return jsonResponse(405, { error: "Nem támogatott HTTP metódus." });
  } catch (err) {
    console.error("Function error:", err);
    return jsonResponse(500, { error: "Szerver hiba", details: err.message });
  } finally {
    client.release();
  }
};
