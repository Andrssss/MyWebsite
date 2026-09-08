// netlify/functions/_ai_revive_core.mjs
//
// Shared logic for the AI-based reactivation check on AI-scraped + ats-crawl
// (2026-09-08, user request). The mechanical dead-rules (BANNER_DEAD_SOURCES /
// SWEEP_PROBE_OVERRIDES in _active_core.mjs) are fixed regex/status checks —
// they can be wrong, and once wrong on a source with no automated re-crawl,
// they stay wrong forever. This gives a periodic AI routine (real judgment on
// the actual page/API response, not a fixed rule) a narrow, DB-credential-free
// way to review the sweep's own kills and reactivate the ones it got wrong —
// same "no DB credential in the routine" shape as _ai_registry_core.mjs
// (AI_SCRAPER_PLAN.md §0). Called from two transports (ai-revive.mjs REST,
// ai-mcp.mjs tools), never directly by a routine.
//
// Why AI-scraped needs this more than most sources: cron_jobs_AI-background.mjs
// (the automated re-crawl worker) has never actually been scheduled (see the
// CLAUDE.md env var notes on ANTHROPIC_API_KEY) — AI-scraped rows are only
// ever written by the in-session/routine discovery path, never re-listed.
// Every OTHER source's reconcileActive self-heals a false sweep kill the
// moment the row reappears in that source's own next crawl (reactivation
// doesn't require `complete`/a scope match on the deactivation half, only
// presence in foundUrls) — AI-scraped has no such crawl to do that.
// ats-crawl DOES get an hourly re-crawl and mostly self-heals this way
// already, but is included too as a second, independent check: per-tenant
// scope-prefix gaps and custom-domain boards can still leave a row with no
// reactivation path (see cron_jobs_ATSCRAWL-background.mjs / _active_core.mjs
// headers for the documented edge cases).
//
// Scope is hard-limited to REVIVE_SOURCES in every query below — even a bad
// LLM verdict or a leaked token can never touch any other source's rows.

import { Pool } from "pg";
import { ensureActiveSchema } from "./_active_core.mjs";
import { logRecovery } from "./_error-logger.mjs";
import { AI_SOURCE } from "./_ai_ingest_core.mjs";

// Mirrors cron_jobs_ATSCRAWL-background.mjs's ATS_SOURCE constant — not
// imported from there to avoid pulling in that file's own top-level DB pool
// just for a string.
export const ATS_CRAWL_SOURCE = "ats-crawl";
export const REVIVE_SOURCES = [AI_SOURCE, ATS_CRAWL_SOURCE];

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

// One fetch per candidate on the routine's side — keeps a single run's cost
// and runtime bounded regardless of how many rows the sweep has ever killed.
const MAX_CANDIDATES = 40;
const MAX_VERDICTS_PER_REQUEST = 200;

let _schemaReady = false;
async function ensureReviveSchema(client) {
  await ensureActiveSchema(client);
  if (_schemaReady) return;
  // Marks a candidate the AI routine already reviewed and confirmed genuinely
  // dead, so it drops out of future candidate lists instead of being
  // re-fetched (and re-billed) every run forever. Reset on reactivation
  // (applyReviveVerdicts) — a row that goes active again should be eligible
  // for a fresh review if it's ever killed again.
  await client.query(
    `ALTER TABLE job_posts ADD COLUMN IF NOT EXISTS ai_revive_checked boolean NOT NULL DEFAULT false`
  );
  _schemaReady = true;
}

export class ReviveRequestError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

/**
 * Rows a sweep (cron_404sweep-background.mjs or the AI/ATS-only
 * cron_ai_ats_deactivate-background.mjs) killed on its own — sweep_dead=true —
 * that the AI routine hasn't reviewed yet. Ordered newest-first: a
 * recently-killed row is more likely to still matter than one dead for weeks.
 */
export async function listReviveCandidates({ limit } = {}) {
  const client = await pool.connect();
  try {
    await ensureReviveSchema(client);
    const cap = Math.max(1, Math.min(Number(limit) || MAX_CANDIDATES, MAX_CANDIDATES));
    const { rows } = await client.query(
      `SELECT url, source, title, company, location, first_seen
         FROM job_posts
        WHERE source = ANY($1::text[])
          AND active = false
          AND sweep_dead = true
          AND ai_revive_checked = false
        ORDER BY first_seen DESC
        LIMIT $2`,
      [REVIVE_SOURCES, cap]
    );
    return { candidates: rows, sources: REVIVE_SOURCES };
  } finally {
    client.release();
  }
}

/**
 * Apply this run's verdicts. `alive` urls are reactivated (active=true,
 * sweep_dead=false, ai_revive_checked reset) exactly like a genuine listing
 * reappearance would — logged via logRecovery like any other reactivation.
 * `stillDead` urls are marked reviewed so they stop being offered as
 * candidates. Both lists are scoped to REVIVE_SOURCES regardless of what the
 * caller sends — a url for any other source is silently ignored, never a
 * live/dead verdict on data this pipeline doesn't own.
 */
export async function applyReviveVerdicts({ alive, stillDead }) {
  const aliveUrls = Array.isArray(alive)
    ? [...new Set(alive.filter((u) => typeof u === "string" && u.trim()))]
    : [];
  const deadUrls = Array.isArray(stillDead)
    ? [...new Set(stillDead.filter((u) => typeof u === "string" && u.trim()))]
    : [];

  if (aliveUrls.length + deadUrls.length === 0) {
    throw new ReviveRequestError("empty", "alive/stillDead (legalább az egyik nem üres tömb) kötelező.");
  }
  if (aliveUrls.length + deadUrls.length > MAX_VERDICTS_PER_REQUEST) {
    throw new ReviveRequestError("too_many_rows", "Too many verdicts in one request", {
      max: MAX_VERDICTS_PER_REQUEST,
      received: aliveUrls.length + deadUrls.length,
    });
  }

  const client = await pool.connect();
  try {
    await ensureReviveSchema(client);

    let reactivated = [];
    if (aliveUrls.length) {
      const res = await client.query(
        `UPDATE job_posts
            SET active = true, sweep_dead = false, ai_revive_checked = false
          WHERE source = ANY($1::text[]) AND url = ANY($2::text[])
          RETURNING url, source`,
        [REVIVE_SOURCES, aliveUrls]
      );
      reactivated = res.rows.map((r) => r.url);
      const bySource = new Map();
      for (const r of res.rows) {
        if (!bySource.has(r.source)) bySource.set(r.source, []);
        bySource.get(r.source).push(r.url);
      }
      for (const [source, urls] of bySource) {
        logRecovery({ type: "ai-reactivated", source, count: urls.length, urls });
      }
    }

    let confirmedDead = [];
    if (deadUrls.length) {
      const res = await client.query(
        `UPDATE job_posts
            SET ai_revive_checked = true
          WHERE source = ANY($1::text[]) AND url = ANY($2::text[])
          RETURNING url`,
        [REVIVE_SOURCES, deadUrls]
      );
      confirmedDead = res.rows.map((r) => r.url);
    }

    return { reactivated, confirmedDead };
  } finally {
    client.release();
  }
}
