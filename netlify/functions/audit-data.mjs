// netlify/functions/audit-data.mjs
//
// Read-only DB snapshot for the two weekly AUDIT ROUTINES (coverage +
// activation). One place, so a routine never has to page the public jobs API
// or — critically — touch a scraper's own code to learn our current DB state.
//
// This is the "OUR state" half of the audit only. The CLAUDE.md rule is that an
// audit must validate a source a DIFFERENT way than the scraper: the routine
// reads our counts/urls from here, then compares them against the live public
// site it fetches ITSELF. This endpoint never fetches or parses any source — it
// only reports what is already in job_posts.
//
//   GET /audit-data
//       → per-source summary rows:
//         { source, active, inactive, newThisWeek, total, timeBased }
//
//   GET /audit-data?filters=1
//       → the `job_filters` title denylist ({id, word}) plus the seniority
//         words that PASS THROUGH it. The coverage routine used to read this
//         straight off the public `GET /filters`, but the 2026-08-25
//         admin-only lockdown put that behind `hasJobBoardAccess`, which
//         AUDIT_TOKEN does not satisfy — so the 2026-08-30 run classified
//         "blacklisted" from a code comment instead of a live read, and said
//         so in its own report. Served here instead of widening /filters:
//         the routine keeps its own narrow token.
//
//   GET /audit-data?source=<raw source>&sample=<n>&offset=<n>
//       → that one source's counts + a page of active & inactive rows
//         (url / title / firstSeen). A source with <= FULL_LIST_MAX active rows
//         returns its ENTIRE active url list (activeFullList:true) so the
//         coverage routine can do an exact live-vs-db diff; bigger sources
//         return a rotating window at ?offset for the activation routine.
//
// Bearer-gated (AUDIT_TOKEN, falling back to CRON_SECRET) — it's for the
// routines, not the public.

import { Pool } from "pg";
import { SENIOR_TITLE_WORDS } from "./_seniority_policy.mjs";

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

// Sources not governed by the active flag (time-window only). The active/
// inactive split is meaningless for them, so the activation routine must skip
// them. Kept in sync with TIME_BASED_SOURCES in jobs.js.
const TIME_BASED = new Set(["LinkedIn"]);

// A source with at most this many active rows returns its FULL active url list,
// so the coverage routine can diff live-site-vs-db exactly instead of sampling.
const FULL_LIST_MAX = 60;

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function authorized(request) {
  const expected = process.env.AUDIT_TOKEN || process.env.CRON_SECRET;
  if (!expected) return false;
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  return token === expected;
}

async function summary(client) {
  const { rows } = await client.query(
    `SELECT source,
            COUNT(*) FILTER (WHERE active = true)::int  AS active,
            COUNT(*) FILTER (WHERE active = false)::int AS inactive,
            COUNT(*) FILTER (WHERE first_seen >= NOW() - INTERVAL '7 days')::int AS new_this_week,
            COUNT(*)::int AS total
       FROM job_posts
      WHERE hidden = false
      GROUP BY source
      ORDER BY source`
  );
  return rows.map((r) => ({
    source: r.source,
    active: r.active,
    inactive: r.inactive,
    newThisWeek: r.new_this_week,
    total: r.total,
    timeBased: TIME_BASED.has(r.source),
  }));
}

// The title denylist the scrapers apply at insert (load_filters.mjs reads the
// same table). Read-only: this endpoint has no write path, so handing it to a
// cloud routine never puts the destructive filter-write tier in a prompt.
async function filterWords(client) {
  const { rows } = await client.query(`SELECT id, word FROM job_filters ORDER BY word`);
  return {
    count: rows.length,
    // Whole-word match, accent-insensitive — see filterRegex in _seniority_policy.mjs.
    matching: "NFD accent-strip + lowercase + (^|[^a-z0-9])word([^a-z0-9]|$)",
    seniorPassThrough: SENIOR_TITLE_WORDS,
    words: rows,
  };
}

async function sourceDetail(client, source, sample, offset) {
  const counts = (await client.query(
    `SELECT COUNT(*) FILTER (WHERE active = true)::int  AS active,
            COUNT(*) FILTER (WHERE active = false)::int AS inactive,
            COUNT(*) FILTER (WHERE first_seen >= NOW() - INTERVAL '7 days')::int AS new_this_week,
            COUNT(*)::int AS total
       FROM job_posts
      WHERE hidden = false AND source = $1`,
    [source]
  )).rows[0];

  const fullActive = counts.active <= FULL_LIST_MAX;

  const activeRows = (await client.query(
    `SELECT url, title, first_seen AS "firstSeen"
       FROM job_posts
      WHERE hidden = false AND source = $1 AND active = true
      ORDER BY id
      ${fullActive ? "" : "OFFSET $3 LIMIT $2"}`,
    fullActive ? [source] : [source, sample, offset]
  )).rows;

  const inactiveRows = (await client.query(
    `SELECT url, title, first_seen AS "firstSeen"
       FROM job_posts
      WHERE hidden = false AND source = $1 AND active = false
      ORDER BY id
      OFFSET $3 LIMIT $2`,
    [source, sample, offset]
  )).rows;

  return {
    source,
    timeBased: TIME_BASED.has(source),
    counts: {
      active: counts.active,
      inactive: counts.inactive,
      newThisWeek: counts.new_this_week,
      total: counts.total,
    },
    activeFullList: fullActive, // true = `active` below is the complete list
    active: activeRows,
    inactive: inactiveRows,
    window: { sample, offset },
  };
}

export default async (request) => {
  if (request.method === "OPTIONS") return new Response("", { status: 204 });
  if (!authorized(request)) return json(401, { error: "Unauthorized" });
  if (request.method !== "GET") return json(405, { error: "GET only" });

  const url = new URL(request.url);
  const source = url.searchParams.get("source");
  const wantFilters = url.searchParams.get("filters") === "1";
  const sample = Math.min(parseInt(url.searchParams.get("sample") || "15", 10) || 15, 100);
  const offset = Math.max(parseInt(url.searchParams.get("offset") || "0", 10) || 0, 0);

  const client = await pool.connect();
  try {
    if (wantFilters) return json(200, await filterWords(client));
    if (source) return json(200, await sourceDetail(client, source, sample, offset));
    return json(200, { sources: await summary(client), generatedAt: new Date().toISOString() });
  } catch (err) {
    console.error("[audit-data] error:", err);
    return json(500, { error: err.message });
  } finally {
    client.release();
  }
};
