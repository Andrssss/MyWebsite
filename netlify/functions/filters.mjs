// netlify/functions/filters.mjs
//
// job_filters (the title-denylist CRUD) moved to the "job-filters" Netlify
// Blob 2026-09-09 — see _job_filters_store.mjs and CLAUDE.md's "Where data
// lives". The PATCH action (count/purge job_posts rows matching a word)
// still hits Postgres — that operates on job_posts, not job_filters.
//
// Rewritten from a CommonJS `exports.handler` (.js) function to this ESM
// `export default` (.mjs, Functions API v2) shape for the same reason as
// reviews.mjs / job-events.mjs: v1-style `exports.handler` functions on this
// site do NOT get Netlify's automatic Blobs context injected — see CLAUDE.md.
import { Pool } from "pg";
import { withDbAuditFlush } from "./_db_audit.js";
import { hasJobBoardAccess, hasAdminSecret } from "./_admin_identity_core.js";
import {
  readFilterState,
  writeFilterState,
  listFilterRows,
  addFilterWord,
  removeFilterWordById,
} from "./_job_filters_store.mjs";

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

const ALLOWED_ORIGIN =
  process.env.ALLOWED_ORIGIN || "https://bakan7.netlify.app";

// hasJobBoardAccess/hasAdminSecret read a Lambda-style `event.headers`
// object; a v2 function gets a Fetch API `Request` instead, so adapt it.
function toEvent(request) {
  return {
    headers: {
      cookie: request.headers.get("cookie") || "",
      authorization: request.headers.get("authorization") || "",
    },
  };
}

function json(statusCode, body) {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    },
  });
}

async function handler(request) {
  const method = request.method;

  if (method === "OPTIONS") {
    return new Response("", {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
        "Access-Control-Allow-Methods": "GET,POST,DELETE,PATCH,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  }

  const event = toEvent(request);

  // The whole /allasfigyelo area is admin-only, so even the read-only
  // filter-word list needs a recognized caller (admin cookie or ADMIN_SECRET
  // bearer). Nothing legitimate reads it anonymously: the scrapers go
  // through load_filters.mjs, straight to the blob.
  if (!hasJobBoardAccess(event)) {
    return json(401, { error: "Unauthorized" });
  }

  // Every mutating action additionally requires the admin secret itself — a
  // little-admin cookie gets past the gate above but must not write.
  if (method !== "GET" && !hasAdminSecret(event)) {
    return json(401, { error: "Unauthorized" });
  }

  try {
    // GET – list all filters
    if (method === "GET") {
      const rows = await listFilterRows();
      return json(200, rows);
    }

    // POST – add a filter word
    if (method === "POST") {
      const { word } = JSON.parse((await request.text()) || "{}");
      if (!word) {
        return json(400, { error: "word kötelező." });
      }
      const trimmed = word.trim();
      if (trimmed.length === 0 || trimmed.length > 100) {
        return json(400, { error: "A szó 1-100 karakter között legyen." });
      }
      const state = await readFilterState();
      const row = addFilterWord(state, trimmed);
      if (!row) {
        return json(409, { error: "Ez a szó már létezik." });
      }
      await writeFilterState(state);
      return json(201, row);
    }

    // DELETE – remove a filter word by id
    if (method === "DELETE") {
      const { id } = JSON.parse((await request.text()) || "{}");
      if (!id) {
        return json(400, { error: "id kötelező." });
      }
      const parsedId = Number(id);
      if (!Number.isFinite(parsedId) || parsedId <= 0) {
        return json(400, { error: "Érvénytelen id." });
      }
      const state = await readFilterState();
      removeFilterWordById(state, parsedId);
      await writeFilterState(state);
      return json(200, { ok: true });
    }

    // PATCH – count or purge jobs matching a filter word (job_posts, Postgres)
    if (method === "PATCH") {
      const { word, action } = JSON.parse((await request.text()) || "{}");
      if (!word || typeof word !== "string") {
        return json(400, { error: "word kötelező." });
      }
      const trimmed = word.trim();
      if (trimmed.length === 0 || trimmed.length > 100) {
        return json(400, { error: "Érvénytelen szó." });
      }

      const whereClause = `WHERE LOWER(title) LIKE '%' || LOWER($1) || '%'`;
      const client = await pool.connect();
      try {
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

        // default: delete. Guard against a too-broad substring wiping the
        // whole table — a 1–2 char word (e.g. "a") matches almost every title.
        if (trimmed.length < 3) {
          return json(400, { error: "Legalább 3 karakteres szó kell a törléshez." });
        }
        const result = await client.query(
          `DELETE FROM job_posts ${whereClause}`,
          [trimmed]
        );
        return json(200, { deleted: result.rowCount });
      } finally {
        client.release();
      }
    }

    return json(405, { error: "Nem támogatott metódus." });
  } catch (err) {
    console.error("filters error:", err);
    return json(500, { error: "Szerver hiba", details: err.message });
  }
}

export default withDbAuditFlush("filters", handler);
