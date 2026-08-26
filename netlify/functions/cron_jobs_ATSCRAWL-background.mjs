/*
  ATS-crawl — több cég publikus ATS-board API-jának aratása egy forrásba.
  Terv: WEB_CRAWLER_PLAN.md (F1). Adapterek: _ats_providers.mjs.

  Mit csinál:
    ats_tenants tábla (provider + cég-slug) → futásonként BATCH_SIZE tenant →
    egy lista-hívás boardonként → szigorú HU-helyszín kapu → (ha kell) EGY
    detail-hívás soronként → ingestJobs.

  Miért nem "web crawler": nincs frontier, nincs link-bejárás. A cég-slug az
  egyetlen bemenet, a board API pedig egy körben adja a teljes nyitott listát.
  A slugok utánpótlása külön feladat (F2, kereső-alapú felderítés) — ez a worker
  csak azt aratja le, ami a táblában van.

  ── Forrás-invariánsok (CLAUDE.md "Scraper invariants") ──────────────────
  • EGY `source` érték ("ats-crawl") mind a több száz tenantra, mert forrásonként
    külön érték szétverné a job_daily_stats-ot és a UI forrás-listáját. Emiatt a
    reconcile KÖTELEZŐEN scope-olt (scopePrefix = a board url-előtagja): source-
    szintű reconcile-lal a 2. tenant kikapcsolná az 1. találatait — ez pontosan a
    DEACTIVATION_AUDIT.md Cat-5 hibája (két scraper egy source-on).
  • Az előtag NEM hardcode-olt, hanem a ténylegesen visszakapott url-ekből
    származik (deriveScopePrefix). Ha nem egységes → complete:false, azaz inkább
    nem deaktiválunk, mint rosszul.
  • ÜRES board → SOSEM deaktiválunk (complete:false). SmartRecruiters-nél a
    nemlétező cég is 200 + üres listát ad (élőben igazolt 2026-08-26), tehát az
    "üres" sosem bizonyíték. A halott sorokat a napi 404-sweep viszi el.
  • A sor az insert ELŐTT teljesen összeáll (experience-write-policy): a
    detail-hívás a HU-szűrés után, de az ingest előtt fut, külön
    fetch-then-UPDATE nincs.
  • Helyszín: a szigorított, FAIL-CLOSED kapu (_ats_location.mjs) — user-döntés
    2026-08-26, üres helyszín itt ELDOBÁS, a rendszer többi részével ellentétben.
  • Senior: NEM dobjuk el (2026-08-25-i szabály) — az ingestJobs
    seniorAwareExperience-e címkézi, a frontend rejti.
*/

import { Pool } from "pg";
import { loadFilters } from "./load_filters.mjs";
import { loadCategories } from "./load_categories.mjs";
import { logFetchError, withTimeout } from "./_error-logger.mjs";
import { migrateVolatileUrl, escapeRegex } from "./_active_core.mjs";
import { extractBodyExperience, extractTechnologies } from "./_experience_core.mjs";
import { getProvider, deriveScopePrefix } from "./_ats_providers.mjs";
import { rejectAtsLocation } from "./_ats_location.mjs";
import { ingestJobs, normalizeUrl } from "./_ai_ingest_core.mjs";

export const ATS_SOURCE = "ats-crawl";

// Hány tenantot dolgozunk fel egy futásban. A background function 15 percet kap;
// egy board = 1 lista-hívás + a HU-sorok detail-hívásai, tipikusan pár másodperc.
const BATCH_SIZE = Number(process.env.ATS_CRAWL_BATCH || 20);

// Újranézési ütem státusz szerint. A 0 magyar állást adó boardokat NEM dobjuk el
// (holnap nyithatnak budapesti pozíciót), csak ritkábban nézzük.
const RECHECK_LIVE_HOURS = 12;
const RECHECK_NO_HU_DAYS = 3;

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error("NETLIFY_DATABASE_URL is not set");

const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

/* ── seed ─────────────────────────────────────────────────────────────
   2026-08-26-i kézi próbából (scratch-script, 64 cég × 4 provider). A lista
   MINDIG lefut ON CONFLICT DO NOTHING-gal, tehát ide felvenni új tenantot =
   deploy után magától bekerül, a meglévők könyvelése (last_checked, hit_count)
   érintetlen marad. Tenantot NE innen töröljünk kikapcsoláshoz — a törölt sor a
   következő deploynál visszajön; helyette status='dead'.

   KIHAGYVA szándékosan: smartrecruiters/Wise és smartrecruiters/RolandBerger —
   azokat a cron_jobs_ATS-background.mjs már aratja "wise"/"roland" source alatt.
   Két scraper ugyanarra a hirdetésre két külön sort írna (a `source` része a
   sor-identitásnak), ami megduplázná őket a listában. */
const SEED_TENANTS = [
  // Van élő budapesti hirdetése (2026-08-26-i mérés)
  { provider: "greenhouse", slug: "wolt", company: "Wolt" },
  { provider: "ashby", slug: "shapr3d", company: "Shapr3D" },
  { provider: "ashby", slug: "craftdocs", company: "Craft" },
  { provider: "ashby", slug: "seon", company: "SEON" },
  // Létező board, jelenleg 0 magyar hirdetéssel — ritkább újranézésre
  { provider: "ashby", slug: "uipath", company: "UiPath" },
  { provider: "ashby", slug: "docplanner", company: "Docplanner" },
  { provider: "ashby", slug: "vantage", company: "Vantage" },
  { provider: "ashby", slug: "bumble", company: "Bumble" },
  { provider: "greenhouse", slug: "celonis", company: "Celonis" },
  { provider: "greenhouse", slug: "n26", company: "N26" },
  { provider: "greenhouse", slug: "typeform", company: "Typeform" },
  { provider: "greenhouse", slug: "cloudflare", company: "Cloudflare" },
  { provider: "greenhouse", slug: "datadog", company: "Datadog" },
  { provider: "greenhouse", slug: "diligent", company: "Diligent" },
  { provider: "greenhouse", slug: "gympass", company: "Wellhub" },
  { provider: "greenhouse", slug: "sumup", company: "SumUp" },
  { provider: "greenhouse", slug: "payoneer", company: "Payoneer" },
  { provider: "greenhouse", slug: "contentful", company: "Contentful" },
  { provider: "lever", slug: "nielsen", company: "Nielsen" },
];

let _schemaReady = false;

async function ensureTenantSchema(client) {
  if (_schemaReady) return;
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
  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_ats_tenants_due ON ats_tenants (status, last_checked)`
  );
  _schemaReady = true;
}

async function seedTenants(client) {
  let added = 0;
  for (const t of SEED_TENANTS) {
    const res = await client.query(
      `INSERT INTO ats_tenants (provider, slug, company, discovered_via)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (provider, slug) DO NOTHING`,
      [t.provider, t.slug, t.company, "manual-probe-2026-08-26"]
    );
    added += res.rowCount ?? 0;
  }
  return added;
}

/*
 * Esedékes tenantok. A rendezés ELSŐ kulcsa szándékosan a `live` státusz: az
 * F2 felderítő tetszőleges számú boardot tud behozni, és azok többsége
 * `no_hu` lesz (idegen cégek, slug-egyezésből — lásd a felderítő addTenant
 * kommentjét). Puszta last_checked-rendezéssel egy nagy no_hu-tömeg kiszorítaná
 * a napi keretből azt a néhány boardot, amelyiken tényleg vannak magyar
 * hirdetések.
 */
async function dueTenants(client, limit) {
  const { rows } = await client.query(
    `SELECT provider, slug, company
       FROM ats_tenants
      WHERE status <> 'dead'
        AND (
          last_checked IS NULL
          OR (status = 'live'  AND last_checked < NOW() - make_interval(hours => $2::int))
          OR (status = 'no_hu' AND last_checked < NOW() - make_interval(days  => $3::int))
        )
      ORDER BY (status = 'live') DESC, last_checked ASC NULLS FIRST
      LIMIT $1`,
    [limit, RECHECK_LIVE_HOURS, RECHECK_NO_HU_DAYS]
  );
  return rows;
}

async function recordTenantResult(client, tenant, { status, huCount, inserted, error }) {
  await client.query(
    `UPDATE ats_tenants
        SET last_checked  = NOW(),
            status        = COALESCE($3, status),
            last_hu_count = COALESCE($4, last_hu_count),
            hit_count     = hit_count + COALESCE($5, 0),
            last_error    = $6
      WHERE provider = $1 AND slug = $2`,
    [tenant.provider, tenant.slug, status ?? null, huCount ?? null, inserted ?? 0, error ?? null]
  );
}

// jobs.smartrecruiters.com/{Company}/{id}-{slug} — a numerikus id ROTÁL, amikor
// a hirdetést frissítik, tehát önmagában nem lehet sor-identitás. Ugyanaz a
// minta, amit a cron_jobs_ATS-background.mjs használ.
function srVolatilePattern(url) {
  const m = String(url).match(/^(https:\/\/jobs\.smartrecruiters\.com\/[^/]+\/)\d+-(.+)$/);
  return m ? `^${escapeRegex(m[1])}\\d+-${escapeRegex(m[2])}$` : null;
}

async function crawlTenant(client, tenant, { filters, categories }) {
  const provider = getProvider(tenant.provider);
  if (!provider) {
    await recordTenantResult(client, tenant, { status: "dead", error: `unknown provider ${tenant.provider}` });
    return { skipped: true };
  }

  const label = `${tenant.provider}/${tenant.slug}`;
  let listing;
  try {
    listing = await provider.list(tenant.slug);
  } catch (err) {
    await logFetchError("cron_jobs_ATSCRAWL-background", { url: label, message: err.message });
    await recordTenantResult(client, tenant, { error: err.message.slice(0, 300) });
    console.error(`[atscrawl] ${label} list failed: ${err.message}`);
    return { failed: true };
  }

  // Nemlétező board — csak ott hihető, ahol a provider tényleg 404-el
  // (smartrecruiters nem, ld. _ats_providers.mjs fejléc).
  if (listing.notFound && provider.detectsMissingTenant) {
    await recordTenantResult(client, tenant, { status: "dead", huCount: 0, error: "board 404" });
    console.log(`[atscrawl] ${label} → DEAD (404)`);
    return { dead: true };
  }

  const boardJobs = listing.jobs || [];

  // 1) helyszín-kapu ELŐSZÖR — a nehéz mezőket (detail-fetch, technológia-
  //    kinyerés) csak a megmaradt sorokra építjük fel. Egy 451 állásos boardon
  //    (datadog) ez a különbség 451 detail-hívás és 0 között.
  const huJobs = [];
  for (const job of boardJobs) {
    if (rejectAtsLocation(job.location)) continue;
    huJobs.push(job);
  }

  console.log(`[atscrawl] ${label}: board=${boardJobs.length} hu=${huJobs.length}`);

  // 2) a HU-sorok teljes felépítése (insert ELŐTT, egyetlen detail-hívással)
  const built = [];
  for (const job of huJobs) {
    let html = job.descriptionHtml;
    let url = job.url;
    if (job.detailRef) {
      try {
        const detail = await provider.detail(job);
        if (typeof detail === "string" || detail === null) {
          html = detail ?? html;
        } else if (detail && typeof detail === "object") {
          html = detail.html ?? html;
          url = detail.url ?? url;
        }
      } catch (err) {
        await logFetchError("cron_jobs_ATSCRAWL-background", { url: job.detailRef, message: err.message });
        console.error(`[atscrawl] ${label} detail failed "${job.title}": ${err.message}`);
      }
    }
    if (!url) {
      console.log(`[atscrawl] ${label} skip no-url: "${job.title}"`);
      continue;
    }
    built.push({
      title: job.title,
      url: normalizeUrl(url) || url,
      company: job.company || tenant.company || null,
      location: job.location,
      experience: (html ? extractBodyExperience(html) : null) || "-",
      technologies: html ? extractTechnologies(html) : null,
    });
  }

  // 3) rotáló-id migráció (csak SmartRecruiters) — a sor URL-je változik, de a
  //    hirdetés ugyanaz; migráció nélkül minden frissítés új sort szülne.
  if (tenant.provider === "smartrecruiters") {
    const currentUrls = built.map((b) => b.url);
    for (const row of built) {
      const pattern = srVolatilePattern(row.url);
      if (!pattern) continue;
      const migrated = await migrateVolatileUrl(client, ATS_SOURCE, row.url, pattern, currentUrls);
      if (migrated) console.log(`[atscrawl] ${label} MIGRATED url → ${row.url}`);
    }
  }

  /* 4) reconcile-scope. A teljes board url-listájából vezetjük le, nem a
        szűrt sorokból — így akkor is helyes marad az előtag, ha épp 0 magyar
        hirdetés van. SmartRecruiters kivétel: ott a lista-elem még nem ismeri a
        publikus url-t (az a detail applyUrl-je), tehát csak a felépített
        HU-sorokból tudunk előtagot képezni. */
  const scopeCandidates = (boardJobs.map((j) => j.url).filter(Boolean).length > 0)
    ? boardJobs.map((j) => j.url).filter(Boolean)
    : built.map((b) => b.url);
  const scopePrefix = deriveScopePrefix(tenant.slug, scopeCandidates);

  // Teljes listázásnak CSAK akkor tekintjük, ha van egységes url-előtag ÉS a
  // board nem üres. Bármelyik hiánya → reactivate-only, a deaktiválást a napi
  // 404-sweep végzi el helyette.
  const fullListing = Boolean(scopePrefix) && boardJobs.length > 0;
  if (!fullListing) {
    console.log(`[atscrawl] ${label} reconcile: reactivate-only (scope=${scopePrefix ?? "n/a"}, board=${boardJobs.length})`);
  }

  const result = await ingestJobs(client, {
    source: ATS_SOURCE,
    jobs: built,
    fullListing,
    filters,
    categories,
    rejectLocation: rejectAtsLocation,
    scopePrefix,
  });

  console.log(
    `[atscrawl] ${label} → hu=${huJobs.length} built=${built.length} inserted=${result.inserted} ` +
    `nonIt=${result.skippedNonIt} filtered=${result.skippedSenior} reconcile=${JSON.stringify(result.reconcile)}`
  );

  await recordTenantResult(client, tenant, {
    status: huJobs.length > 0 ? "live" : "no_hu",
    huCount: huJobs.length,
    inserted: result.inserted,
    error: null,
  });

  return { huCount: huJobs.length, inserted: result.inserted };
}

const _runJob = withTimeout("cron_jobs_ATSCRAWL-background", async () => {
  const [filters, categories] = await Promise.all([loadFilters(), loadCategories()]);

  const client = await pool.connect();
  let checked = 0;
  let totalHu = 0;
  let totalInserted = 0;
  try {
    await ensureTenantSchema(client);
    const seeded = await seedTenants(client);
    if (seeded) console.log(`[atscrawl] seeded ${seeded} new tenant(s)`);

    const tenants = await dueTenants(client, BATCH_SIZE);
    console.log(`[atscrawl] due tenants: ${tenants.length}`);

    for (const tenant of tenants) {
      const r = await crawlTenant(client, tenant, { filters, categories });
      checked += 1;
      totalHu += r.huCount ?? 0;
      totalInserted += r.inserted ?? 0;
    }

    console.log(`[atscrawl] DONE — tenants=${checked} hu_rows=${totalHu} inserted=${totalInserted}`);
  } finally {
    client.release();
  }

  return new Response("OK");
});

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  const expected = process.env.CRON_SECRET;
  if (!expected || token !== expected) {
    return new Response("Unauthorized", { status: 401 });
  }
  return _runJob(request);
};
