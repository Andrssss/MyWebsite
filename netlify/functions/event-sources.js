// netlify/functions/event-sources.js
//
// Admin CRUD for the job-events forrás-regiszter (`event_sources`) — ugyanaz
// a minta, mint az ai-extractors.js: egy sor itt annyit jelent, hogy
// cron_job_events-background.mjs ezt az oldalt is beolvassa és AI-val
// kinyeri belőle a közelgő állásbörzéket/eventeket a "job-events" blobba.
//
// Ugyanaz a hitelesítési szerződés, mint ai-extractors/ai-ingest/ai-registry:
// AI_INGEST_TOKEN, amíg az nincs beállítva CRON_SECRET. Szándékosan NEM
// ADMIN_SECRET — ez is az AI-család szűk tokenje, böngészőből semmi nem
// hívja, csak curl.

const { Pool } = require("pg");
const { withDbAuditFlush } = require("./_db_audit.js");
const { safeEqual } = require("./_admin_identity_core");

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "https://bakan7.netlify.app";

// "jsonld" (2026-09-11): deterministic schema.org/Event JSON-LD extraction,
// no AI — see cron_job_events-background.mjs / _events_jsonld_core.mjs. Only
// valid for a source that actually embeds it (kibernaptar.hu does; verify
// before switching a source to this mode, the cron just silently finds 0
// events on a page without it, no error).
const MODES = new Set(["llm-read", "jsonld", "disabled"]);

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

function toSlug(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function ensureTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS event_sources (
      site        text PRIMARY KEY,
      list_url    text NOT NULL,
      mode        text NOT NULL DEFAULT 'llm-read',
      last_ok     timestamptz,
      fail_streak int NOT NULL DEFAULT 0
    )
  `);
}

exports.handler = withDbAuditFlush("event-sources", async (event) => {
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

  if (!authorized(event)) {
    return json(401, { error: "Unauthorized" });
  }

  let client;
  try {
    client = await pool.connect();
    await ensureTable(client);

    if (method === "GET") {
      const { rows } = await client.query(
        `SELECT site, list_url, mode, last_ok, fail_streak FROM event_sources ORDER BY site`
      );
      return json(200, rows);
    }

    // POST — add a source { site, list_url, mode? }
    if (method === "POST") {
      const { site, list_url, mode } = JSON.parse(event.body || "{}");
      const slug = toSlug(site);
      if (!slug) return json(400, { error: "site (slug) kötelező." });
      if (!list_url || !/^https?:\/\//i.test(list_url)) {
        return json(400, { error: "list_url érvényes http(s) URL legyen." });
      }
      const m = MODES.has(mode) ? mode : "llm-read";
      const { rows } = await client.query(
        `INSERT INTO event_sources (site, list_url, mode)
         VALUES ($1, $2, $3)
         ON CONFLICT (site) DO NOTHING
         RETURNING site, list_url, mode`,
        [slug, list_url, m]
      );
      if (rows.length === 0) return json(409, { error: "Ez a site már létezik." });
      return json(201, rows[0]);
    }

    // PATCH — update { site, list_url?, mode? }
    if (method === "PATCH") {
      const { site, list_url, mode } = JSON.parse(event.body || "{}");
      const slug = toSlug(site);
      if (!slug) return json(400, { error: "site kötelező." });
      if (mode && !MODES.has(mode)) return json(400, { error: "mode: llm-read | disabled" });
      if (list_url && !/^https?:\/\//i.test(list_url)) return json(400, { error: "list_url érvénytelen." });

      const sets = [];
      const params = [slug];
      if (list_url) { params.push(list_url); sets.push(`list_url = $${params.length}`); }
      if (mode) { params.push(mode); sets.push(`mode = $${params.length}`); }
      if (sets.length === 0) return json(400, { error: "Nincs mit frissíteni." });

      const { rows } = await client.query(
        `UPDATE event_sources SET ${sets.join(", ")} WHERE site = $1
         RETURNING site, list_url, mode`,
        params
      );
      if (rows.length === 0) return json(404, { error: "Nincs ilyen site." });
      return json(200, rows[0]);
    }

    // DELETE — remove a source { site }
    if (method === "DELETE") {
      const { site } = JSON.parse(event.body || "{}");
      const slug = toSlug(site);
      if (!slug) return json(400, { error: "site kötelező." });
      await client.query(`DELETE FROM event_sources WHERE site = $1`, [slug]);
      return json(200, { ok: true });
    }

    return json(405, { error: "Nem támogatott metódus." });
  } catch (err) {
    console.error("event-sources error:", err);
    return json(500, { error: "Szerver hiba", details: err.message });
  } finally {
    client?.release();
  }
});
