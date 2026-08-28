// netlify/functions/ai-extractors.js
//
// Admin CRUD for the AI-scraped site registry (`ai_extractors`), so new sites
// can be added without DB creds — same pattern as categories.js / filters.js.
// See AI_SCRAPER_PLAN.md. Adding a site here is all it takes for
// cron_jobs_AI-background.mjs to start ingesting it into source `AI - <site>`.
//
// INVARIANT: only add sites we do NOT already have a hand scraper for.

const { Pool } = require("pg");
const { withDbAuditFlush } = require("./_db_audit.js");
const { safeEqual } = require("./_admin_identity_core");

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "https://bakan7.netlify.app";

const MODES = new Set(["llm-read", "recipe", "disabled"]);

// Ugyanaz a szerződés, mint az ai-ingest/ai-registry/ai-deactivate/ats-tenants
// végpontokon: AI_INGEST_TOKEN, és amíg az nincs beállítva, CRON_SECRET.
function authorized(event) {
  const expected = (process.env.AI_INGEST_TOKEN || process.env.CRON_SECRET || "").trim();
  if (!expected) return false;
  const hdr =
    (event.headers && (event.headers.authorization || event.headers.Authorization)) || "";
  const token = hdr.replace(/^Bearer\s+/i, "").trim();
  return token.length > 0 && safeEqual(token, expected);
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    },
    body: JSON.stringify(body),
  };
}

// slug: lowercase, alnum + dash only — becomes source `AI - <slug>`.
function toSlug(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function ensureTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ai_extractors (
      site         text PRIMARY KEY,
      source_value text NOT NULL,
      list_url     text NOT NULL,
      mode         text NOT NULL DEFAULT 'llm-read',
      recipe       jsonb,
      recipe_model text,
      last_ok      timestamptz,
      last_regen   timestamptz,
      fail_streak  int NOT NULL DEFAULT 0
    )
  `);
  await client.query(
    `ALTER TABLE ai_extractors ADD COLUMN IF NOT EXISTS full_listing boolean NOT NULL DEFAULT false`
  );
}

exports.handler = withDbAuditFlush("ai-extractors", async (event) => {
  const method = event.httpMethod;

  if (method === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
        "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
      body: "",
    };
  }

  /* Auth: AI_INGEST_TOKEN, MINDEN metódusra (2026-08-28).
     Eddig NULLA hitelesítés volt rajta, pedig ez a végpont dönti el, milyen
     oldalakat arat be a `cron_jobs_AI-background.mjs` az `AI - <site>`
     forrásokba: egy POST-tal bárki tetszőleges list_url-t tehetett a
     pipeline-ba (a mi infrastruktúránkkal fetchelve), DELETE-tel pedig
     kiüríthette a regisztert. A GET sem ártalmatlan — a teljes aratási
     konfigurációnkat listázza.
     A kulcs SZÁNDÉKOSAN az AI-család szűk tokenje (`ai-ingest`, `ai-registry`,
     `ai-deactivate`, `ats-tenants` ugyanezt használja), NEM az ADMIN_SECRET:
     az AI-utak sosem tartanak destruktív kulcsot, és ez az endpoint is az AI
     regiszterhez tartozik. Böngészőből semmi nem hívja, csak curl. */
  if (!authorized(event)) {
    return json(401, { error: "Unauthorized" });
  }

  let client;
  try {
    client = await pool.connect();
    await ensureTable(client);

    // GET — list sites (with status, without the possibly-large recipe body)
    if (method === "GET") {
      const { rows } = await client.query(
        `SELECT site, source_value, list_url, mode, full_listing, recipe_model, last_ok, last_regen, fail_streak,
                (recipe IS NOT NULL) AS has_recipe
           FROM ai_extractors ORDER BY site`
      );
      return json(200, rows);
    }

    // POST — add a site { site, list_url, mode?, full_listing? }
    if (method === "POST") {
      const { site, list_url, mode, full_listing } = JSON.parse(event.body || "{}");
      const slug = toSlug(site);
      if (!slug) return json(400, { error: "site (slug) kötelező." });
      if (!list_url || !/^https?:\/\//i.test(list_url)) {
        return json(400, { error: "list_url érvényes http(s) URL legyen." });
      }
      const m = MODES.has(mode) ? mode : "llm-read";
      const { rows } = await client.query(
        `INSERT INTO ai_extractors (site, source_value, list_url, mode, full_listing)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (site) DO NOTHING
         RETURNING site, source_value, list_url, mode, full_listing`,
        [slug, `AI - ${slug}`, list_url, m, full_listing === true]
      );
      if (rows.length === 0) return json(409, { error: "Ez a site már létezik." });
      return json(201, rows[0]);
    }

    // PATCH — update { site, list_url?, mode?, full_listing?, clear_recipe? }
    if (method === "PATCH") {
      const { site, list_url, mode, full_listing, clear_recipe } = JSON.parse(event.body || "{}");
      const slug = toSlug(site);
      if (!slug) return json(400, { error: "site kötelező." });
      if (mode && !MODES.has(mode)) return json(400, { error: "mode: llm-read | recipe | disabled" });
      if (list_url && !/^https?:\/\//i.test(list_url)) return json(400, { error: "list_url érvénytelen." });

      const sets = [];
      const params = [slug];
      if (list_url) { params.push(list_url); sets.push(`list_url = $${params.length}`); }
      if (mode) { params.push(mode); sets.push(`mode = $${params.length}`); }
      if (typeof full_listing === "boolean") { params.push(full_listing); sets.push(`full_listing = $${params.length}`); }
      if (clear_recipe) sets.push(`recipe = NULL, recipe_model = NULL`);
      if (sets.length === 0) return json(400, { error: "Nincs mit frissíteni." });

      const { rows } = await client.query(
        `UPDATE ai_extractors SET ${sets.join(", ")} WHERE site = $1
         RETURNING site, source_value, list_url, mode, full_listing`,
        params
      );
      if (rows.length === 0) return json(404, { error: "Nincs ilyen site." });
      return json(200, rows[0]);
    }

    // DELETE — remove a site { site }
    if (method === "DELETE") {
      const { site } = JSON.parse(event.body || "{}");
      const slug = toSlug(site);
      if (!slug) return json(400, { error: "site kötelező." });
      await client.query(`DELETE FROM ai_extractors WHERE site = $1`, [slug]);
      return json(200, { ok: true });
    }

    return json(405, { error: "Nem támogatott metódus." });
  } catch (err) {
    console.error("ai-extractors error:", err);
    return json(500, { error: "Szerver hiba", details: err.message });
  } finally {
    client?.release();
  }
});
