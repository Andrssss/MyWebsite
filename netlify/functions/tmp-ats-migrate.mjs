// netlify/functions/tmp-ats-migrate.mjs
//
// ELDOBHATÓ, egyszer használatos endpoint (2026-09-03). A `ats_tenants` /
// `ats_slug_candidates` / `ats_seen_companies` Postgres-táblák teljes
// tartalmát átmásolja a Blobs-ra költözött _ats_state.mjs store-jaiba
// (`tenants.json`, `candidates.json`) — a tábláK MAGUK nem törlődnek, csak a
// kód nem olvassa/írja őket többé.
//
// MIÉRT KELL: a blob-store első olvasása üres objektumot ad vissza. Migráció
// nélkül a hosszú crawl-történet (~200-300 tenant status/lastChecked/hitCount,
// ~2300+ próbált slug-jelölt, a teljes seenCompanies lista) egyszerűen ELVÉSZ
// a deploy pillanatában — ez a hiba akkor derült ki, amikor a user
// rákérdezett, hogy "nem vesztünk semmit ugye?".
//
// Használat után `git rm netlify/functions/tmp-ats-migrate.mjs`.
//
//   BASE=https://bakan7.netlify.app/.netlify/functions/tmp-ats-migrate
//
//   # 1. állapotfelmérés (semmit nem ír, mindkét oldalt megmutatja):
//   curl -s "$BASE?token=TOKEN&action=scan"
//
//   # 2. tényleges migráció (csak akkor ír, ha a blob még üres, kivéve force=1):
//   curl -s -X POST "$BASE?token=TOKEN&action=migrate"

import "@netlify/blobs";
import { Pool } from "pg";
import { readTenants, writeTenants, readCandidateState, writeCandidateState } from "./_ats_state.mjs";

// Egyszer használatos, ebbe a fájlba generált token — szándékosan NEM env var
// (a CRON_SECRET maszkolt a CLI-ban), és a fájllal együtt megszűnik.
const TOKEN = "9f3b7e0c4d2a41b6a0f5c8e9d7b2136f0a4c";

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

function json(status, body) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function iso(d) {
  return d ? new Date(d).toISOString() : null;
}

async function loadFromPostgres(client) {
  const tenants = {};
  let tenantRowCount = 0;
  try {
    const { rows } = await client.query(`SELECT * FROM ats_tenants`);
    tenantRowCount = rows.length;
    for (const r of rows) {
      tenants[`${r.provider}:${r.slug}`] = {
        provider: r.provider,
        slug: r.slug,
        company: r.company ?? null,
        status: r.status ?? "live",
        lastChecked: iso(r.last_checked),
        lastHuCount: r.last_hu_count ?? 0,
        hitCount: r.hit_count ?? 0,
        lastError: r.last_error ?? null,
        discoveredVia: r.discovered_via ?? null,
        createdAt: iso(r.created_at) ?? new Date().toISOString(),
      };
    }
  } catch (err) {
    if (err.code !== "42P01") throw err; // 42P01 = relation does not exist — nincs mit migrálni
  }

  const candidates = {};
  let candidateRowCount = 0;
  try {
    const { rows } = await client.query(`SELECT * FROM ats_slug_candidates`);
    candidateRowCount = rows.length;
    for (const r of rows) {
      candidates[r.slug] = {
        slug: r.slug,
        sourceCompany: r.source_company ?? null,
        status: r.status ?? "new",
        hitProvider: r.hit_provider ?? null,
        probedAt: iso(r.probed_at),
        probedProviders: r.probed_providers ?? [],
        createdAt: iso(r.created_at) ?? new Date().toISOString(),
      };
    }
  } catch (err) {
    if (err.code !== "42P01") throw err;
  }

  const seenCompanies = {};
  let seenCompanyRowCount = 0;
  try {
    const { rows } = await client.query(`SELECT * FROM ats_seen_companies`);
    seenCompanyRowCount = rows.length;
    for (const r of rows) {
      seenCompanies[r.company] = { seenAt: iso(r.seen_at) ?? new Date().toISOString(), slugCount: r.slug_count ?? 0 };
    }
  } catch (err) {
    if (err.code !== "42P01") throw err;
  }

  return {
    tenants, candidates, seenCompanies,
    counts: { tenantRowCount, candidateRowCount, seenCompanyRowCount },
  };
}

export default async (request) => {
  const url = new URL(request.url);
  if (url.searchParams.get("token") !== TOKEN) return json(401, { error: "Unauthorized" });

  const action = url.searchParams.get("action") || "scan";
  const force = url.searchParams.get("force") === "1";

  const client = await pool.connect();
  let pg;
  try {
    pg = await loadFromPostgres(client);
  } finally {
    client.release();
  }

  const currentTenants = await readTenants();
  const currentCandidateState = await readCandidateState();

  const blobState = {
    tenants: Object.keys(currentTenants).length,
    candidates: Object.keys(currentCandidateState.candidates).length,
    seenCompanies: Object.keys(currentCandidateState.seenCompanies).length,
  };

  if (action === "scan") {
    return json(200, { postgres: pg.counts, blobs: blobState, force, note: "semmit nem írt — csak állapotfelmérés" });
  }

  if (action !== "migrate") return json(400, { error: "unknown action", allowed: ["scan", "migrate"] });

  const blobHasData = blobState.tenants > 0 || blobState.candidates > 0 || blobState.seenCompanies > 0;
  if (blobHasData && !force) {
    return json(409, {
      error: "blob store already has data — pass &force=1 to overwrite it with the Postgres snapshot",
      blobs: blobState,
    });
  }

  await writeTenants(pg.tenants);
  await writeCandidateState({ candidates: pg.candidates, seenCompanies: pg.seenCompanies });

  return json(200, {
    migrated: {
      tenants: Object.keys(pg.tenants).length,
      candidates: Object.keys(pg.candidates).length,
      seenCompanies: Object.keys(pg.seenCompanies).length,
    },
    postgresRowCounts: pg.counts,
  });
};
