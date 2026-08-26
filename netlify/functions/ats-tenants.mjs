// netlify/functions/ats-tenants.mjs
//
// A kereső-alapú ATS-felderítés (WEB_CRAWLER_PLAN.md F2, §3.2a) beviteli pontja:
// a felhő-routine WebSearch-csel talált ATS-hirdetéslinkeket / cég-slugokat
// küld ide, a szerver pedig ellenőrzi és felveszi őket az `ats_tenants`
// táblába. Learatni már a cron_jobs_ATSCRAWL-background.mjs fogja őket.
//
//   GET  → a routine MEMÓRIÁJA. A routine minden futásban hidegen indul
//          (persist_session:false), tehát enélkül ugyanazt a 20 céget javasolná
//          örökké. Visszaadja a már ismert tenantokat + a próbált-és-nem-létező
//          slugokat, hogy tudja, mit NE küldjön újra.
//
//   POST → felvétel. Kétféle bemenet, keverhető:
//            {"urls": ["https://jobs.ashbyhq.com/acme/123", ...]}
//            {"tenants": [{"provider":"ashby","slug":"acme","company":"ACME"}]}
//          Az url-alak a jobb: abból a slug KIOLVASHATÓ, nem tippelni kell.
//
// Miért ellenőriz a szerver is?  Ugyanaz az elv, mint az ai-registry-nél: az
// LLM saját ítélete sosem az egyetlen kapu. Minden felvett slugot élesben
// leprobálunk (_ats_slug_core.probeSlug), és csak a valóban létező boardok
// kerülnek be — így egy félreolvasott url vagy egy hallucinált cégnév nem
// szemeteli tele a rotációt. Kivétel a SmartRecruiters, ami nemlétező cégre is
// 200-at ad: ott a hirdetés-URL megléte maga a bizonyíték, tippelt slugot
// viszont nem fogadunk el.
//
// Auth: AI_INGEST_TOKEN (fallback CRON_SECRET) — szándékosan ugyanaz a szűk
// hatókörű token, amit az ai-registry használ, hogy a routine tárolt promptjába
// SOHA ne kelljen CRON_SECRET-et írni (az a teljes cron-flottát vezérelné).
//
//   curl https://bakan7.netlify.app/.netlify/functions/ats-tenants \
//     -H "Authorization: Bearer $AI_INGEST_TOKEN"
//
//   curl -X POST https://bakan7.netlify.app/.netlify/functions/ats-tenants \
//     -H "Authorization: Bearer $AI_INGEST_TOKEN" -H "Content-Type: application/json" \
//     -d '{"urls":["https://jobs.ashbyhq.com/seon/abc"],"tenants":[{"provider":"lever","slug":"acme"}]}'

import { Pool } from "pg";
import { parseAtsUrl, probeSlug, PROBEABLE_PROVIDERS } from "./_ats_slug_core.mjs";
import { PROVIDER_IDS } from "./_ats_providers.mjs";

// Egy kérésben ennyi tenant vehető fel. Nem visszaélés-védelem (a token úgyis
// bizalmi), hanem a futásidő korlátja: minden elem egy élő HTTP-próba.
const MAX_ITEMS = 40;

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, no-store" },
  });
}

function authorized(request) {
  const expected = process.env.AI_INGEST_TOKEN || process.env.CRON_SECRET;
  if (!expected) return false;
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  return token === expected;
}

// Ugyanaz a 401-diagnosztika, mint az ai-registry-ben: megmondja, MELYIK
// env-változóhoz hasonlítunk és jött-e egyáltalán bearer — a titokból semmit.
// Enélkül a "nincs beállítva", "elgépelt" és "még nem deployolt" esetek
// kívülről megkülönböztethetetlenek.
function authDiagnostic(request) {
  return {
    comparingAgainst: process.env.AI_INGEST_TOKEN ? "AI_INGEST_TOKEN"
      : process.env.CRON_SECRET ? "CRON_SECRET (fallback — AI_INGEST_TOKEN is NOT set)"
      : "nothing (neither AI_INGEST_TOKEN nor CRON_SECRET is set)",
    bearerReceived: /^Bearer\s+\S/i.test(request.headers.get("authorization") || ""),
  };
}

async function ensureSchema(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ats_tenants (
      provider        text NOT NULL,
      slug            text NOT NULL,
      company         text,
      status          text NOT NULL DEFAULT 'live',
      last_checked    timestamptz,
      last_hu_count   integer NOT NULL DEFAULT 0,
      hit_count       integer NOT NULL DEFAULT 0,
      last_error      text,
      discovered_via  text,
      created_at      timestamptz NOT NULL DEFAULT NOW(),
      PRIMARY KEY (provider, slug)
    )
  `);
}

async function handleGet(client) {
  await ensureSchema(client);
  const { rows: tenants } = await client.query(
    `SELECT provider, slug, company, status, last_hu_count, last_checked
       FROM ats_tenants ORDER BY provider, slug`
  );
  // A már cáfolt slugok is a memória része: enélkül a routine ugyanazt a
  // nemlétező boardot javasolná minden héten.
  let knownMisses = [];
  try {
    const { rows } = await client.query(
      `SELECT slug FROM ats_slug_candidates WHERE status = 'miss' ORDER BY slug LIMIT 2000`
    );
    knownMisses = rows.map((r) => r.slug);
  } catch {
    // A jelölt-táblát a discover worker hozza létre; ha még nem futott, üres lista.
  }
  return json(200, {
    tenants,
    counts: {
      total: tenants.length,
      live: tenants.filter((t) => t.status === "live").length,
      noHu: tenants.filter((t) => t.status === "no_hu").length,
      dead: tenants.filter((t) => t.status === "dead").length,
    },
    knownMisses,
    probeableProviders: PROBEABLE_PROVIDERS,
    supportedProviders: PROVIDER_IDS,
  });
}

async function handlePost(client, request) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  await ensureSchema(client);

  /** @type {Map<string, {provider:string, slug:string, company:string|null, fromUrl:boolean}>} */
  const wanted = new Map();
  const rejected = [];

  for (const raw of Array.isArray(payload?.urls) ? payload.urls : []) {
    const parsed = parseAtsUrl(raw);
    if (!parsed) { rejected.push({ input: String(raw).slice(0, 200), reason: "not a supported ATS url" }); continue; }
    const key = `${parsed.provider}:${parsed.slug}`;
    if (!wanted.has(key)) wanted.set(key, { ...parsed, company: null, fromUrl: true });
  }

  for (const t of Array.isArray(payload?.tenants) ? payload.tenants : []) {
    const provider = String(t?.provider ?? "").toLowerCase().trim();
    const slug = String(t?.slug ?? "").toLowerCase().trim();
    if (!PROVIDER_IDS.includes(provider) || !slug) {
      rejected.push({ input: `${provider}:${slug}`, reason: "unknown provider or empty slug" });
      continue;
    }
    // Tippelt SmartRecruiters-slug nem ellenőrizhető (a nemlétező cég is 200-at
    // ad), ezért csak valódi hirdetés-url-ből fogadjuk el.
    if (!PROBEABLE_PROVIDERS.includes(provider)) {
      rejected.push({ input: `${provider}:${slug}`, reason: "provider cannot be verified — submit a real posting url instead" });
      continue;
    }
    const key = `${provider}:${slug}`;
    const company = t?.company ? String(t.company).slice(0, 200) : null;
    if (!wanted.has(key)) wanted.set(key, { provider, slug, company, fromUrl: false });
  }

  const items = [...wanted.values()];
  if (items.length > MAX_ITEMS) {
    return json(413, { error: `Too many items in one request (${items.length} > ${MAX_ITEMS})`, max: MAX_ITEMS });
  }

  const added = [];
  const alreadyKnown = [];
  const notFound = [];

  for (const item of items) {
    const { rows: existing } = await client.query(
      `SELECT 1 FROM ats_tenants WHERE provider = $1 AND slug = $2`,
      [item.provider, item.slug]
    );
    if (existing.length > 0) { alreadyKnown.push(`${item.provider}:${item.slug}`); continue; }

    // Az url-ből származó SmartRecruiters-tenantot nem tudjuk leprobálni, de az
    // url megléte már bizonyíték; a többit élesben ellenőrizzük.
    if (PROBEABLE_PROVIDERS.includes(item.provider)) {
      const r = await probeSlug(item.provider, item.slug);
      if (r === "miss") { notFound.push(`${item.provider}:${item.slug}`); continue; }
      if (r === "error") { rejected.push({ input: `${item.provider}:${item.slug}`, reason: "probe failed (network/rate limit) — retry later" }); continue; }
    }

    // A `company` itt is NULL marad, ugyanazért, amiért a felderítő workerben
    // (lásd annak addTenant kommentjét): a slug megléte nem azonosítja a céget,
    // és egy hibás névből a hirdetéseinkre hibás cégnév kerülne. A beküldött
    // nevet eredet-megjegyzésként tároljuk, nem tényként — a valódi cégnevet a
    // provider adja, ha tudja.
    await client.query(
      `INSERT INTO ats_tenants (provider, slug, company, discovered_via)
       VALUES ($1,$2,NULL,$3)
       ON CONFLICT (provider, slug) DO NOTHING`,
      [
        item.provider,
        item.slug,
        `${item.fromUrl ? "search-url" : "search-slug"}${item.company ? `:${item.company.slice(0, 150)}` : ""}`,
      ]
    );
    added.push(`${item.provider}:${item.slug}`);
  }

  return json(200, {
    submitted: items.length,
    added,
    alreadyKnown,
    notFound,
    rejected,
    note: "Added tenants are harvested by the daily ats-crawl worker; nothing is written to job_posts here.",
  });
}

export default async (request) => {
  if (!authorized(request)) return json(401, { error: "Unauthorized", ...authDiagnostic(request) });

  const client = await pool.connect();
  try {
    if (request.method === "GET") return await handleGet(client);
    if (request.method === "POST") return await handlePost(client, request);
    return json(405, { error: "GET or POST only" });
  } finally {
    client.release();
  }
};
