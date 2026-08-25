const { Pool } = require("pg");
const { withDbAuditFlush } = require("./_db_audit.js");
const { hasJobBoardAccess } = require("./_admin_identity_core");
const { TECH_KEYWORDS } = require("./_tech_keywords.js");

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

// Category → associated technologies (2026-08-06): lets the frontend
// auto-select a category's typical tech filters when the category itself
// gets picked (e.g. "Frontend fejlesztő" pulling in React/Vue/TypeScript/...)
// instead of technologies being a flat, unrelated filter dimension. Only
// ever holds canonical TECH_KEYWORDS labels — validated on write below —
// so the admin UI can offer a closed picker rather than free text.
const VALID_TECH_LABELS = new Set(TECH_KEYWORDS.map(([, label]) => label));

let _schemaReady = false;
async function ensureSchema(client) {
  if (_schemaReady) return;
  await client.query(
    `ALTER TABLE job_categories ADD COLUMN IF NOT EXISTS technologies text[] NOT NULL DEFAULT '{}'`
  );
  _schemaReady = true;
}

const ALLOWED_ORIGIN =
  process.env.ALLOWED_ORIGIN || "https://bakan7.netlify.app";

// Admin auth: a real server-side secret (never committed to source). Falls back
// to CRON_SECRET so this keeps working until ADMIN_SECRET is set in Netlify.
function authorized(event) {
  // Trimmed: see filters.js — a pasted trailing newline would silently reject all.
  const expected = (process.env.ADMIN_SECRET || process.env.CRON_SECRET || "").trim();
  if (!expected) return false;
  const hdr =
    (event.headers && (event.headers.authorization || event.headers.Authorization)) || "";
  const token = hdr.replace(/^Bearer\s+/i, "").trim();
  return token.length > 0 && token === expected;
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

exports.handler = withDbAuditFlush("categories", async (event) => {
  const method = event.httpMethod;

  if (method === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
        "Access-Control-Allow-Methods": "GET,POST,DELETE,PATCH,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
      body: "",
    };
  }

  // The whole /allasfigyelo area is admin-only now, so even the read-only
  // category list needs a recognized caller (admin cookie or ADMIN_SECRET
  // bearer). The scrapers don't go through here — load_categories.mjs reads
  // the DB directly — so nothing legitimate calls this anonymously.
  if (!hasJobBoardAccess(event)) {
    return json(401, { error: "Unauthorized" });
  }

  // Mutations additionally require the admin secret itself — a little-admin
  // cookie gets past the gate above but must not write.
  if (method !== "GET" && !authorized(event)) {
    return json(401, { error: "Unauthorized" });
  }

  let client;
  try {
    client = await pool.connect();
    await ensureSchema(client);

    // GET – list all categories with keywords + associated technologies
    if (method === "GET") {
      const { rows } = await client.query(
        `SELECT id, name, keywords, technologies FROM job_categories ORDER BY id`
      );
      return json(200, rows);
    }

    // POST – add a new category
    if (method === "POST") {
      const { name, keywords, technologies } = JSON.parse(event.body || "{}");
      if (!name || typeof name !== "string") {
        return json(400, { error: "name kötelező." });
      }
      const trimmedName = name.trim();
      if (trimmedName.length === 0 || trimmedName.length > 100) {
        return json(400, { error: "A név 1-100 karakter között legyen." });
      }
      const kws = Array.isArray(keywords)
        ? keywords.map((k) => String(k).trim()).filter(Boolean)
        : [];
      const techs = Array.isArray(technologies)
        ? [...new Set(technologies.filter((t) => VALID_TECH_LABELS.has(t)))]
        : [];

      const { rows } = await client.query(
        `INSERT INTO job_categories (name, keywords, technologies)
         VALUES ($1, $2, $3)
         ON CONFLICT (name) DO NOTHING
         RETURNING id, name, keywords, technologies`,
        [trimmedName, kws, techs]
      );
      if (rows.length === 0) {
        return json(409, { error: "Ez a kategória már létezik." });
      }
      return json(201, rows[0]);
    }

    // PATCH – update keywords and/or associated technologies for a category
    if (method === "PATCH") {
      const { id, keywords, technologies } = JSON.parse(event.body || "{}");
      if (!id) {
        return json(400, { error: "id kötelező." });
      }
      const parsedId = Number(id);
      if (!Number.isFinite(parsedId) || parsedId <= 0) {
        return json(400, { error: "Érvénytelen id." });
      }
      if (!Array.isArray(keywords) && !Array.isArray(technologies)) {
        return json(400, { error: "keywords vagy technologies tömb kötelező." });
      }

      const sets = [];
      const params = [parsedId];
      if (Array.isArray(keywords)) {
        params.push(keywords.map((k) => String(k).trim()).filter(Boolean));
        sets.push(`keywords = $${params.length}`);
      }
      if (Array.isArray(technologies)) {
        params.push([...new Set(technologies.filter((t) => VALID_TECH_LABELS.has(t)))]);
        sets.push(`technologies = $${params.length}`);
      }

      const { rows } = await client.query(
        `UPDATE job_categories SET ${sets.join(", ")} WHERE id = $1
         RETURNING id, name, keywords, technologies`,
        params
      );
      if (rows.length === 0) {
        return json(404, { error: "Kategória nem található." });
      }
      return json(200, rows[0]);
    }

    // DELETE – remove a category by id
    if (method === "DELETE") {
      const { id } = JSON.parse(event.body || "{}");
      if (!id) {
        return json(400, { error: "id kötelező." });
      }
      const parsedId = Number(id);
      if (!Number.isFinite(parsedId) || parsedId <= 0) {
        return json(400, { error: "Érvénytelen id." });
      }
      await client.query(`DELETE FROM job_categories WHERE id = $1`, [parsedId]);
      return json(200, { ok: true });
    }

    return json(405, { error: "Nem támogatott metódus." });
  } catch (err) {
    console.error("categories error:", err);
    return json(500, { error: "Szerver hiba", details: err.message });
  } finally {
    client?.release();
  }
});
