// netlify/functions/jobs.js
const { neon } = require("@neondatabase/serverless");
const { getJobsCacheGeneration } = require("./_jobs_cache_core");
const { TECH_KEYWORDS } = require("./_tech_keywords");

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) {
  console.error("❌ NETLIFY_DATABASE_URL nincs beállítva.");
  throw new Error("NETLIFY_DATABASE_URL environment variable is not set.");
}

// fullResults:true → sql.query(text, params) returns { rows, ... } like pg Pool
const sql =
  globalThis.__neonSqlClient ||
  neon(connectionString, { fullResults: true });
globalThis.__neonSqlClient = sql;

// Convenience wrapper — exactly like the other project's sql.query()
const sqlQuery = {
  query: (text, params) => sql.query(text, params),
};

// Make sure the active-flag column exists before we filter on it. Runs once per
// warm container; the sweep + scrapers create it too, this just avoids a 500 if
// the frontend is hit before the first sweep runs after a deploy.
let schemaEnsured = globalThis.__jobsSchemaEnsured || false;
async function ensureSchema() {
  if (schemaEnsured) return;
  try {
    await sqlQuery.query(
      `ALTER TABLE job_posts ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true`
    );
    await sqlQuery.query(
      `ALTER TABLE job_posts ADD COLUMN IF NOT EXISTS technologies text`
    );
  } catch (err) {
    console.error("ensureSchema failed:", err.message);
  }
  schemaEnsured = true;
  globalThis.__jobsSchemaEnsured = true;
}

function jsonResponse(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "https://bakan7.netlify.app",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}

// In-memory cache (per warm container). TTL in ms.
const CACHE_TTL_MS = 60 * 1000; // 60s
const cache = globalThis.__jobsCache || new Map();
globalThis.__jobsCache = cache;

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.t > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.v;
}

function cacheSet(key, value) {
  if (cache.size > 200) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
  cache.set(key, { t: Date.now(), v: value });
}

// Cross-container cache-bust — see _jobs_cache_core.js for why this can't just
// be an in-process cache.clear() call from job-hidden.js. Fails open: if
// Blobs has a hiccup, we skip invalidation rather than break the whole jobs
// endpoint over a caching nicety.
let lastSeenCacheGen;

async function syncCacheGeneration() {
  try {
    const currentGen = await getJobsCacheGeneration();
    if (currentGen !== lastSeenCacheGen) {
      cache.clear();
      lastSeenCacheGen = currentGen;
    }
  } catch (err) {
    console.error("[jobs] cache-generation check failed (serving from existing cache):", err.message);
  }
}

const CACHE_HEADERS = {
  "Cache-Control": "public, max-age=60, s-maxage=60, stale-while-revalidate=120",
  // The response body now depends on the admin cookie, so shared caches must
  // never serve one visitor's variant to another.
  Vary: "Cookie",
};

// Admin ("little admin") responses contain hidden rows → they must NEVER be
// stored by the shared Netlify CDN, only by that one browser.
const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store",
  Vary: "Cookie",
};

// Read-only elevated access: seeing `hidden` job rows. Deliberately a SEPARATE
// credential from ADMIN_SECRET (which authorizes destructive actions) — if this
// one leaks, the blast radius is "someone sees hidden ads", not data loss.
//
// Identity resolution (which env vars count, cookie matching, timing-safe
// compare) lives in _admin_identity_core.js, shared with job-applied.js — a
// duplicated copy here is exactly what caused the 2026-07-23 LITTLE_ADMIN_4..7
// → ADMIN_1..4 rename to silently break this file while job-applied.js's
// separate check kept working.
const { isRecognizedAdmin, hasJobBoardAccess } = require("./_admin_identity_core");

// One-line boot log so "is any key even configured?" is answerable from the
// function log without exposing values. isRecognizedAdmin re-reads process.env
// per call (cheap: a handful of string comparisons), so this is diagnostic
// only, not a cached gate.
console.log(
  `[jobs] admin/little-admin env keys present: ${
    Object.keys(process.env).filter((k) => /^(LITTLE_ADMIN(_\d+)?|ADMIN_\d+)$/.test(k)).length
  }`
);

const isLittleAdmin = isRecognizedAdmin;

// FIXED lista (key/label)
const FIXED = [
  { key: "AI-scraped", label: "AI-scraped" },

  { key: "karrierhungaria", label: "Karrier Hungaria" },

  { key: "minddiak", label: "Minddiák" },
  { key: "muisz", label: "Muisz" },
  { key: "zyntern", label: "Zyntern" },
  { key: "profession-intern", label: "Profession" },
  { key: "schonherz", label: "Schönherz – Budapest" },
  { key: "tudasdiak", label: "Tudasdiak" },
  { key: "otp", label: "OTP" },
  { key: "vizmuvek", label: "vizmuvek" },
  { key: "LinkedIn", label: "LinkedIn PAST 24H" },
  { key: "wherewework", label: "wherewework" },
  { key: "onejob", label: "onejob" },
  { key: "miszisz", label: "MISZISZ" },
  { key: "nofluffjobs", label: "nofluffjobs" },
  { key: "dreamjobs", label: "DreamJobs" },
  { key: "melonjobs", label: "MelonJobs" },
  { key: "kuka", label: "KUKA" },
  { key: "talent", label: "Talent" },
  { key: "bluebird", label: "bluebird" },
  { key: "ydiak", label: "Y Diák" },
  { key: "qdiak", label: "Q Diák" },
  { key: "alllocaljobs", label: "AllLocalJobs" },
  { key: "allasportal", label: "Állásportál" },
  { key: "prodiak", label: "Prodiák" },

  { key: "mbh", label: "MBH Bank" },
  { key: "kh", label: "K&H Bank" },
  { key: "raiffeisen", label: "Raiffeisen Bank" },
  { key: "erste", label: "Erste Bank" },
  { key: "mfb", label: "MFB Bank" },
  { key: "unicredit", label: "UniCredit Bank" },
  { key: "cg-jobstream", label: "Capgemini" },
  { key: "wise", label: "Wise" },
  { key: "roland", label: "Roland Berger" },
  { key: "eudiakok", label: "euDiákok" },
  { key: "melodiak", label: "MelóDiák" },
  { key: "atlasz", label: "Atlasz Munkák" },
  { key: "pannondiak", label: "PannonDiák" },
  { key: "valorebasis", label: "Valore Basis" },
  { key: "trenkwalder", label: "Trenkwalder" },
  { key: "workcenter", label: "WorkCenter" },
  { key: "workly", label: "Workly" },
  { key: "random_email", label: "Random Email" },
  { key: "Hays", label: "Hays" },
  { key: "nix", label: "NIX" },
  { key: "startupjobs", label: "Startup Jobs" },
  { key: "ats-crawl", label: "ATS boardok" },
];

// Sources still shown by time window (NOT governed by the active flag). For now
// only LinkedIn: it can only ever see a recent window, so "not seen this run"
// never means "gone" and it can't be reconciled. Everything else defaults to
// the active flag (no time limit) when no explicit timeRange is requested.
const TIME_BASED_SOURCES = new Set(["LinkedIn"]);
const TIME_BASED_SOURCES_ARRAY = [...TIME_BASED_SOURCES];

// Parameterized query helper. Returns rows array.
async function query(text, params = []) {
  const { rows } = await sqlQuery.query(text, params);
  return rows;
}

exports.handler = async (event) => {
  const method = event.httpMethod;
  const path = event.path || "";
  const parts = path.split("/");
  const maybeId = parts[parts.length - 1];
  const id = /^\d+$/.test(maybeId) ? parseInt(maybeId, 10) : null;

  if (method === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "Access-Control-Allow-Origin": "https://bakan7.netlify.app/allasfigyelo",
        "Access-Control-Allow-Methods": "GET,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
      body: "",
    };
  }

  // /allasfigyelo is admin-only since 2026-08-25: ordinary visitors are
  // redirected to pestidev.hu before the page mounts, so nothing legitimate
  // calls this endpoint without a credential. The redirect is UX; THIS is the
  // access control — without it the whole job list stays a public URL away.
  if (!hasJobBoardAccess(event)) {
    return jsonResponse(401, { error: "Unauthorized" }, PRIVATE_HEADERS);
  }

  // Does this request see hidden rows? Decided ONCE per request and folded into
  // the cache key + response headers below.
  const admin = isLittleAdmin(event);
  const respHeaders = admin ? PRIVATE_HEADERS : CACHE_HEADERS;

  if (method === "GET") {
    // Must happen BEFORE the cache-hit check below, or a stale in-memory entry
    // (from before the most recent hide/unhide) could still be served this request.
    await syncCacheGeneration();
  }

  // Cache check BEFORE hitting db
  let cacheKey = null;
  if (method === "GET") {
    const qs = event.queryStringParameters || {};
    const qsSorted = Object.keys(qs).sort().map((k) => `${k}=${qs[k]}`).join("&");
    // `admin:` prefix is REQUIRED: without it an admin response (containing
    // hidden rows) would be cached under the same key and then served to the
    // next ordinary visitor — leaking exactly what `hidden` is meant to hide.
    cacheKey = `${admin ? "a" : "p"}|${path}?${qsSorted}`;
    const cached = cacheGet(cacheKey);
    if (cached) {
      return jsonResponse(200, cached, { ...respHeaders, "X-Cache": "HIT" });
    }
  }

  try {
    await ensureSchema();

    if (method === "GET") {
      const qs = event.queryStringParameters || {};
      const source = qs.source || null;
      const onlyNew = qs.onlyNew === "1" || qs.onlyNew === "true";
      const timeRangeRaw = String(qs.timeRange || "").toLowerCase();
      const timeRange =
        timeRangeRaw === "24h" || timeRangeRaw === "1d"
          ? "24h"
          : timeRangeRaw === "7d" || timeRangeRaw === "1w" || timeRangeRaw === "week"
          ? "7d"
          : timeRangeRaw === "30d" || timeRangeRaw === "1m" || timeRangeRaw === "month"
          ? "30d"
          : onlyNew
          ? "24h"
          : null;
      const limit = Math.min(parseInt(qs.limit || "500", 10) || 5000, 5000);

      // Hidden-row predicate. NOT user input — derived from the boolean above,
      // so interpolating it into the SQL text is safe (no injection surface).
      // Ordinary visitors get the hidden-filter; little-admin gets everything.
      const HID = admin ? "TRUE" : "hidden = false";

      // The `hidden` flag itself is only ever sent to little-admin, so the
      // public response shape stays byte-for-byte what it was before.
      const HIDCOL = admin ? ", hidden" : "";

      // GET /jobs/sources
      if (path.endsWith("/jobs/sources") || path.endsWith("/jobs/sources/")) {
        const rows = await query(
          `SELECT source, COUNT(*)::int AS count
           FROM job_posts
           WHERE ${HID}
             AND ((source = ANY($1) AND first_seen >= NOW() - INTERVAL '30 days')
              OR (source <> ALL($1) AND (active = true OR first_seen >= NOW() - INTERVAL '30 days')))
           GROUP BY source`,
          [TIME_BASED_SOURCES_ARRAY]
        );

        const map = new Map(rows.map((r) => [r.source, r]));
        const out = FIXED.map((s) => {
          const dbKeys = s.keys || [s.key];
          const count = dbKeys.reduce((sum, k) => sum + (map.get(k)?.count ?? 0), 0);
          return { source: s.key, label: s.label, count };
        });

        // FIXED is the LABEL + ordering registry, not an allowlist. Any source
        // present in the DB but missing from it is appended with its raw key as
        // the label, so a newly added scraper can never be invisible in the
        // filter chips just because nobody remembered to edit this file.
        // (2026-08-26: "ats-crawl" shipped and its rows were in the job list,
        // but the chip was missing entirely — the same stale-hardcoded-list bug
        // class as the category-ID allowlists. The v2 allasfigyelo reader
        // already derives its chips from the DB for exactly this reason.)
        const covered = new Set(FIXED.flatMap((s) => s.keys || [s.key]));
        for (const [source, row] of map) {
          if (covered.has(source)) continue;
          if (source.startsWith("AI - ")) continue; // legacy per-company AI keys fold into AI-scraped
          out.push({ source, label: source, count: row.count });
        }

        out.sort((a, b) => a.label.localeCompare(b.label, "hu"));

        cacheSet(cacheKey, out);
        return jsonResponse(200, out, { ...respHeaders, "X-Cache": "MISS" });
      }

      // GET /jobs/technologies — every technology extractTechnologies() can
      // recognize, not just ones a currently-loaded job happens to have. Lets
      // the frontend list (and filter by) a tech before any loaded posting
      // has it yet.
      if (path.endsWith("/jobs/technologies") || path.endsWith("/jobs/technologies/")) {
        const labels = [...new Set(TECH_KEYWORDS.map(([, label]) => label))].sort((a, b) =>
          a.localeCompare(b, "hu")
        );
        cacheSet(cacheKey, labels);
        return jsonResponse(200, labels, { ...respHeaders, "X-Cache": "MISS" });
      }

      // GET /jobs/:id
      if (id) {
        const rows = await query(
          `SELECT source, title, url, company,
                  first_seen AS "firstSeen",
                  experience, technologies, active${HIDCOL}
           FROM job_posts
           WHERE id = $1 AND ${HID}`,
          [id]
        );
        if (rows.length === 0) return jsonResponse(404, { error: "Nem található." });
        cacheSet(cacheKey, rows[0]);
        return jsonResponse(200, rows[0], { ...respHeaders, "X-Cache": "MISS" });
      }

      // GET /jobs?source=...
      if (source) {
        const fixedEntry = FIXED.find((s) => s.key === source);
        const dbKeys = fixedEntry?.keys || [source];
        const isTimeBased = dbKeys.every((k) => TIME_BASED_SOURCES.has(k));
        const sourceQuery =
          timeRange === "24h"
            ? `SELECT source, title, url, company,
                      first_seen AS "firstSeen",
                      experience, technologies, active${HIDCOL}
               FROM job_posts
               WHERE ${HID} AND source = ANY($1)
                 AND first_seen >= NOW() - INTERVAL '24 hours'
               ORDER BY first_seen DESC, id DESC
               LIMIT $2`
            : timeRange === "7d"
            ? `SELECT source, title, url, company,
                      first_seen AS "firstSeen",
                      experience, technologies, active${HIDCOL}
               FROM job_posts
               WHERE ${HID} AND source = ANY($1)
                 AND first_seen >= NOW() - INTERVAL '7 days'
               ORDER BY first_seen DESC, id DESC
               LIMIT $2`
            : isTimeBased
            ? `SELECT source, title, url, company,
                      first_seen AS "firstSeen",
                      experience, technologies, active${HIDCOL}
               FROM job_posts
               WHERE ${HID} AND source = ANY($1)
                 AND first_seen >= NOW() - INTERVAL '30 days'
               ORDER BY first_seen DESC, id DESC
               LIMIT $2`
            : `SELECT source, title, url, company,
                      first_seen AS "firstSeen",
                      experience, technologies, active${HIDCOL}
               FROM job_posts
               WHERE ${HID} AND source = ANY($1)
                 AND (active = true OR first_seen >= NOW() - INTERVAL '30 days')
               ORDER BY first_seen DESC, id DESC
               LIMIT $2`;

        const rows = await query(sourceQuery, [dbKeys, limit]);
        cacheSet(cacheKey, rows);
        return jsonResponse(200, rows, { ...respHeaders, "X-Cache": "MISS" });
      }

      // GET /jobs
      const allQuery =
        timeRange === "24h"
          ? `SELECT source, title, url, company,
                    first_seen AS "firstSeen",
                    experience, technologies, active${HIDCOL}
             FROM job_posts
             WHERE ${HID} AND first_seen >= NOW() - INTERVAL '24 hours'
             ORDER BY first_seen DESC, id DESC
             LIMIT $1`
          : timeRange === "7d"
          ? `SELECT source, title, url, company,
                    first_seen AS "firstSeen",
                    experience, technologies, active${HIDCOL}
             FROM job_posts
             WHERE ${HID} AND first_seen >= NOW() - INTERVAL '7 days'
             ORDER BY first_seen DESC, id DESC
             LIMIT $1`
          : timeRange === "30d"
          ? // Every timeRange branch must take exactly ONE parameter: the call below
            // passes [limit] alone whenever timeRange is set. Without this branch "30d"
            // fell through to the two-parameter default and the request 500'd — which
            // is what the UI sends with the 24h+7d filters both on (JobWatcher.jsx).
            `SELECT source, title, url, company,
                    first_seen AS "firstSeen",
                    experience, technologies, active${HIDCOL}
             FROM job_posts
             WHERE ${HID} AND first_seen >= NOW() - INTERVAL '30 days'
             ORDER BY first_seen DESC, id DESC
             LIMIT $1`
          : `SELECT source, title, url, company,
                    first_seen AS "firstSeen",
                    experience, technologies, active${HIDCOL}
             FROM job_posts
             WHERE ${HID}
               AND ((source = ANY($2) AND first_seen >= NOW() - INTERVAL '30 days')
                OR (source <> ALL($2) AND (active = true OR first_seen >= NOW() - INTERVAL '30 days')))
             ORDER BY first_seen DESC, id DESC
             LIMIT $1`;

      const rows = await query(allQuery, timeRange ? [limit] : [limit, TIME_BASED_SOURCES_ARRAY]);
      cacheSet(cacheKey, rows);
      return jsonResponse(200, rows, { ...respHeaders, "X-Cache": "MISS" });
    }

    if (method === "DELETE") {
      return jsonResponse(403, {
        error: "A törlés API-ból tiltva van.",
      });
    }

    return jsonResponse(405, { error: "Nem támogatott HTTP metódus." });
  } catch (err) {
    console.error("Function error:", err);
    return jsonResponse(500, { error: "Szerver hiba", details: err.message });
  }
};
