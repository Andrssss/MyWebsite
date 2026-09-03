// netlify/functions/_ats_state.mjs
//
// ATS crawl/discover bookkeeping (formerly `ats_tenants` / `ats_slug_candidates`
// / `ats_seen_companies` in Postgres), moved to Netlify Blobs 2026-09-03.
//
// Why: none of these three tables held content anything else ever read (no
// frontend, no stats page) — pure crawl-state churn. But they generated a lot
// of write traffic: `seedTenants` alone re-asserted ~35 `ON CONFLICT DO
// NOTHING` INSERTs on EVERY hourly ats-crawl run whether or not anything
// changed, plus a per-tenant/per-candidate UPDATE for every row touched that
// run (up to ~30 + 45 statements/hour). None of it needs SQL: each store is
// small (tenants: low hundreds; candidates: low thousands) and every access
// pattern here is either a full scan+sort (dueTenants/dueCandidates, exactly
// what Postgres would do anyway at this size) or a single-key existence
// check — both trivial in memory. What still needs Postgres — job_posts
// upserts, and the intake anti-join against job_posts.company — stays there;
// see cron_ats_discover-background.mjs.
//
// Write discipline: callers read once at the top of a run, mutate the plain
// object/map in memory via the helpers below, and write back ONCE at the end
// — only if a mutating helper actually changed something (see the `dirty`
// pattern in the callers). A key that's already present is a no-op: no read,
// no write, unlike the old ON CONFLICT DO NOTHING which was still a write.
//
// Consistency note: unlike a Postgres row UPDATE, a blob write here replaces
// the WHOLE document, so two concurrent read-modify-write calls could clobber
// each other. Accepted because the writers run on a schedule offset by
// minutes (ats-crawl :14, ats-discover :25) or fire rarely (ats-tenants.mjs
// is hit by the discovery routine, not continuously), and the worst case of a
// lost update is a tenant/candidate getting (re)checked one run late — it
// self-heals within the hour, nothing is lost permanently.

import { getStore } from "@netlify/blobs";

const STORE_NAME = "ats-state";
const TENANTS_KEY = "tenants.json";
const CANDIDATES_KEY = "candidates.json";

function store() {
  return getStore({ name: STORE_NAME, consistency: "strong" });
}

export function tenantKey(provider, slug) {
  return `${provider}:${slug}`;
}

/* ── tenants ──────────────────────────────────────────────────────────────
   { "<provider>:<slug>": { provider, slug, company, status, lastChecked,
     lastHuCount, hitCount, lastError, discoveredVia, createdAt } }        */

export async function readTenants() {
  const raw = await store().get(TENANTS_KEY, { type: "json" });
  return raw && typeof raw === "object" ? raw : {};
}

export async function writeTenants(tenants) {
  await store().setJSON(TENANTS_KEY, tenants);
}

// Mirrors the old `INSERT ... ON CONFLICT (provider, slug) DO NOTHING`.
// Returns true (and mutates `tenants`) only when a new row was actually
// created — an existing key is a pure no-op, not a write.
export function addTenantIfNew(tenants, provider, slug, { company = null, discoveredVia = null } = {}) {
  const key = tenantKey(provider, slug);
  if (tenants[key]) return false;
  tenants[key] = {
    provider,
    slug,
    company: company ?? null,
    status: "live",
    lastChecked: null,
    lastHuCount: 0,
    hitCount: 0,
    lastError: null,
    discoveredVia: discoveredVia ?? null,
    createdAt: new Date().toISOString(),
  };
  return true;
}

// Mirrors the old per-tenant `UPDATE ats_tenants SET last_checked=NOW(), ...`.
export function applyTenantResult(tenants, provider, slug, { status, huCount, inserted, error }) {
  const t = tenants[tenantKey(provider, slug)];
  if (!t) return;
  t.lastChecked = new Date().toISOString();
  if (status != null) t.status = status;
  if (huCount != null) t.lastHuCount = huCount;
  if (inserted) t.hitCount = (t.hitCount || 0) + inserted;
  t.lastError = error ?? null;
}

/*
 * Esedékes tenantok — 1:1 port a régi kétlépcsős SQL-ből
 * (cron_jobs_ATSCRAWL-background.mjs korábbi dueTenants-kommentje adja a
 * teljes indoklást: miért kell a `live` boardoknak elsőbbség, és miért kell
 * a "sosem nézett" csoportnak KÜLÖN, a limit-en felüli keret).
 */
export function selectDueTenants(tenants, { limit, reserveLimit, recheckNoHuDays }) {
  const noHuCutoff = Date.now() - recheckNoHuDays * 86400000;
  const all = Object.values(tenants).filter((t) => t.status !== "dead");
  const checkedAt = (t) => (t.lastChecked ? new Date(t.lastChecked).getTime() : -Infinity);

  const primary = all
    .filter((t) => !t.lastChecked || t.status === "live" || (t.status === "no_hu" && checkedAt(t) < noHuCutoff))
    .sort((a, b) => {
      const aReady = a.status === "live" && a.lastChecked != null;
      const bReady = b.status === "live" && b.lastChecked != null;
      if (aReady !== bReady) return aReady ? -1 : 1;
      return checkedAt(a) - checkedAt(b);
    })
    .slice(0, limit);

  const seen = new Set(primary.map((t) => tenantKey(t.provider, t.slug)));
  const reserve = all
    .filter((t) => !t.lastChecked || (t.status === "no_hu" && checkedAt(t) < noHuCutoff))
    .filter((t) => !seen.has(tenantKey(t.provider, t.slug)))
    .sort((a, b) => checkedAt(a) - checkedAt(b))
    .slice(0, reserveLimit);

  return [...primary, ...reserve];
}

/* ── candidates + seen-companies ─────────────────────────────────────────
   { candidates: { <slug>: {slug, sourceCompany, status, hitProvider,
                             probedAt, probedProviders, createdAt} },
     seenCompanies: { <company>: {seenAt, slugCount} } }                   */

export async function readCandidateState() {
  const raw = await store().get(CANDIDATES_KEY, { type: "json" });
  if (!raw || typeof raw !== "object") return { candidates: {}, seenCompanies: {} };
  return {
    candidates: raw.candidates && typeof raw.candidates === "object" ? raw.candidates : {},
    seenCompanies: raw.seenCompanies && typeof raw.seenCompanies === "object" ? raw.seenCompanies : {},
  };
}

export async function writeCandidateState(state) {
  await store().setJSON(CANDIDATES_KEY, { candidates: state.candidates, seenCompanies: state.seenCompanies });
}

export function addCandidateIfNew(candidates, slug, sourceCompany) {
  if (candidates[slug]) return false;
  candidates[slug] = {
    slug,
    sourceCompany,
    status: "new",
    hitProvider: null,
    probedAt: null,
    probedProviders: [],
    createdAt: new Date().toISOString(),
  };
  return true;
}

export function applyCandidateResult(candidates, slug, status, hitProvider, probedProviders) {
  const c = candidates[slug];
  if (!c) return;
  c.status = status;
  if (hitProvider) c.hitProvider = hitProvider;
  c.probedAt = new Date().toISOString();
  c.probedProviders = probedProviders;
}

/*
 * Esedékes jelöltek — 1:1 port a régi dueCandidates SQL-ből. Három csoport,
 * ebben a fontossági sorrendben:
 *   1. `new`   — még sosem próbált slug (ide esnek az új cégnevek is)
 *   2. `error` — hálózati hiba miatt eldöntetlen, retryErrorDays után újra
 *   3. `miss`  — cáfolt, DE van olyan providerünk, amin még nem próbáltuk
 *                (provider-bővítés; ld. a probedProviders mező kommentjét)
 *
 * A rendezés első kulcsa azért a `new`, mert a 3. csoport egy több ezres
 * egyszeri backlog: nélküle egy frissen felvett cégnév napokig a sor végén
 * ülne (ugyanaz a kiéheztetési hibaosztály, mint az ATSCRAWL tenant-
 * rotációjánál, ld. selectDueTenants fejléce).
 */
export function selectDueCandidates(candidates, { limit, retryErrorDays, probeableProviders }) {
  const errorCutoff = Date.now() - retryErrorDays * 86400000;
  const probedAt = (c) => (c.probedAt ? new Date(c.probedAt).getTime() : -Infinity);
  const isDue = (c) => {
    if (c.status === "new") return true;
    if (c.status === "error") return c.probedAt != null && probedAt(c) < errorCutoff;
    if (c.status === "miss") return !probeableProviders.every((p) => (c.probedProviders || []).includes(p));
    return false;
  };
  return Object.values(candidates)
    .filter(isDue)
    .sort((a, b) => {
      const aNew = a.status === "new";
      const bNew = b.status === "new";
      if (aNew !== bNew) return aNew ? -1 : 1;
      const diff = probedAt(a) - probedAt(b);
      if (diff !== 0) return diff;
      const aC = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bC = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return aC - bC;
    })
    .slice(0, limit);
}
