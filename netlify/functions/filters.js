const { Pool } = require("pg");
const { withDbAuditFlush } = require("./_db_audit.js");
const { hasJobBoardAccess } = require("./_admin_identity_core");

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

const ALLOWED_ORIGIN =
  process.env.ALLOWED_ORIGIN || "https://bakan7.netlify.app";

// Admin auth: a real server-side secret, never committed to source. The old
// model (a hardcoded visitor UUID checked against a source-committed allowlist)
// was public in the repo, so anyone could purge the DB. Falls back to
// CRON_SECRET so this keeps working until ADMIN_SECRET is set in Netlify.
function authorized(event) {
  // Trimmed: a secret pasted into the Netlify env UI often carries a trailing
  // newline, which would silently reject every request with no diagnosable error.
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

exports.handler = withDbAuditFlush("filters", async (event) => {
  const method = event.httpMethod;

  if (method === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
        "Access-Control-Allow-Methods": "GET,POST,DELETE,PATCH,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
      body: "",
    };
  }

  // The whole /allasfigyelo area is admin-only now, so even the read-only
  // filter-word list needs a recognized caller (admin cookie or ADMIN_SECRET
  // bearer). It used to be public — nothing legitimate reads it anonymously:
  // the scrapers go through load_filters.mjs, straight to the DB.
  if (!hasJobBoardAccess(event)) {
    return json(401, { error: "Unauthorized" });
  }

  // Every mutating action additionally requires the admin secret itself — a
  // little-admin cookie gets past the gate above but must not write.
  if (method !== "GET" && !authorized(event)) {
    return json(401, { error: "Unauthorized" });
  }

  let client;
  try {
    client = await pool.connect();

    // GET – list all filters
    if (method === "GET") {
      const { rows } = await client.query(
        `SELECT id, word FROM job_filters ORDER BY word`
      );
      return json(200, rows);
    }

    // POST – add a filter word
    if (method === "POST") {
      const { word } = JSON.parse(event.body || "{}");
      if (!word) {
        return json(400, { error: "word kötelező." });
      }
      const trimmed = word.trim();
      if (trimmed.length === 0 || trimmed.length > 100) {
        return json(400, { error: "A szó 1-100 karakter között legyen." });
      }
      const { rows } = await client.query(
        `INSERT INTO job_filters (word)
         VALUES ($1)
         ON CONFLICT (LOWER(word)) DO NOTHING
         RETURNING id, word`,
        [trimmed]
      );
      if (rows.length === 0) {
        return json(409, { error: "Ez a szó már létezik." });
      }
      return json(201, rows[0]);
    }

    // DELETE – remove a filter word by id
    if (method === "DELETE") {
      const { id } = JSON.parse(event.body || "{}");
      if (!id) {
        return json(400, { error: "id kötelező." });
      }
      const parsedId = Number(id);
      if (!Number.isFinite(parsedId) || parsedId <= 0) {
        return json(400, { error: "Érvénytelen id." });
      }
      await client.query(`DELETE FROM job_filters WHERE id = $1`, [parsedId]);
      return json(200, { ok: true });
    }

    // PATCH – count or purge jobs matching a filter word
    if (method === "PATCH") {
      const { word, action } = JSON.parse(event.body || "{}");
      if (!word || typeof word !== "string") {
        return json(400, { error: "word kötelező." });
      }
      const trimmed = word.trim();
      if (trimmed.length === 0 || trimmed.length > 100) {
        return json(400, { error: "Érvénytelen szó." });
      }

      const whereClause = `WHERE LOWER(title) LIKE '%' || LOWER($1) || '%'`;

      if (action === "count") {
        const countRes = await client.query(
          `SELECT COUNT(*)::int AS count FROM job_posts ${whereClause}`,
          [trimmed]
        );
        const titlesRes = await client.query(
          `SELECT title FROM job_posts ${whereClause} ORDER BY first_seen DESC LIMIT 100`,
          [trimmed]
        );
        return json(200, { count: countRes.rows[0].count, titles: titlesRes.rows.map(r => r.title) });
      }

      // default: delete. Guard against a too-broad substring wiping the whole
      // table — a 1–2 char word (e.g. "a") matches almost every title.
      if (trimmed.length < 3) {
        return json(400, { error: "Legalább 3 karakteres szó kell a törléshez." });
      }
      const result = await client.query(
        `DELETE FROM job_posts ${whereClause}`,
        [trimmed]
      );
      return json(200, { deleted: result.rowCount });
    }

    return json(405, { error: "Nem támogatott metódus." });
  } catch (err) {
    console.error("filters error:", err);
    return json(500, { error: "Szerver hiba", details: err.message });
  } finally {
    client?.release();
  }
});
