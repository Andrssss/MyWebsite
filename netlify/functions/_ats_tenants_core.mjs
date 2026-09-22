// netlify/functions/_ats_tenants_core.mjs
//
// A kereső-alapú ATS-felderítés (WEB_CRAWLER_PLAN.md F2, §3.2a) egyetlen
// implementációja — ezt hívja mind a REST endpoint (ats-tenants.mjs), mind az
// MCP tool (ai-mcp.mjs `get_ats_discovery` / `submit_ats_tenants`), ugyanúgy
// ahogy _ai_registry_core.mjs a registry GET/POST-ját osztja meg a két
// transport között. 2026-09-22: a GET-válasz `instructions.promptSnippet`-je
// (lásd routineInstructions lent) évekkel korábban egy curl+AI_INGEST_TOKEN
// hívást javasolt a routine promptjának — ez SOSEM lett bekötve, és mire
// ténylegesen bekötésre került volna, a routine időközben (2026-09-15) MCP-only
// lett a registry-hívásokra pont azért, mert egy modell-komponálta Bash
// parancs `Authorization: Bearer <token>`-nel külső hostra az auto-mode
// permission classifier blokkolja (lásd ai-mcp.mjs fejléce) — egy új
// curl-alapú hívás ugyanígy elakadt volna minden felügyelet nélküli futásban.
// Ezért ez a csatorna is MCP toolként lett bekötve, nem promptSnippet-ként;
// az `instructions` mező innentől csak a REST-hívóknak (kézi curl, tesztelés)
// szól, a routine az MCP tool leírásából tudja, mit kell tennie.

import { parseAtsUrl, probeSlug, PROBEABLE_PROVIDERS } from "./_ats_slug_core.mjs";
import { PROVIDER_IDS } from "./_ats_providers.mjs";
import { readTenants, writeTenants, addTenantIfNew, readCandidateState, tenantKey } from "./_ats_state.mjs";

// Egy híváskor ennyi tenant vehető fel. Nem visszaélés-védelem, hanem a
// futásidő korlátja: minden elem egy élő HTTP-próba.
export const MAX_ITEMS = 40;

const QUERY_BANK = [
  "site:jobs.ashbyhq.com Budapest",
  "site:jobs.ashbyhq.com Hungary junior",
  "site:job-boards.greenhouse.io Budapest",
  "site:job-boards.greenhouse.io Hungary intern",
  "site:boards.greenhouse.io Budapest",
  "site:jobs.lever.co Budapest",
  "site:jobs.lever.co Magyarország",
  "site:jobs.smartrecruiters.com Budapest",
  "site:jobs.ashbyhq.com gyakornok",
  "site:job-boards.greenhouse.io \"Budapest, Hungary\" engineer",
  "site:teamtailor.com Budapest",
  "site:teamtailor.com Magyarország",
  "site:bamboohr.com/careers Budapest",
  // 2026-09-22: Workday hiányzott a bankból, pedig WEB_CRAWLER_PLAN.md §9 (F7) szerint ez a
  // legnagyobb hozamú bővítés (nagyvállalati/SSC budapesti irodák) — és slug-tippeléssel
  // (cron_ats_discover-background.mjs) elérhetetlen, mert 3 ismeretlent kellene kitalálni
  // (tenant + site + wdN host); csak keresésből vagy kézzel vehető fel.
  "site:myworkdayjobs.com Budapest",
  "site:myworkdayjobs.com Hungary",
];

// Napi rotáció: a routine nem tárol állapotot futások között, tehát ha mindig a
// bank elejét kapná, a lista végét soha nem keresné ki senki. A nap sorszáma
// determinisztikus és külön memória nélkül lépteti az ablakot.
function suggestedQueries(count = 4) {
  const dayIndex = Math.floor(Date.now() / 86400000);
  return Array.from({ length: Math.min(count, QUERY_BANK.length) },
    (_, i) => QUERY_BANK[(dayIndex * count + i) % QUERY_BANK.length]);
}

function routineInstructions() {
  return {
    purpose:
      "ATS-boardok felderítése. Az itt felvett cégeket a napi ats-crawl worker aratja le; " +
      "ez az endpoint NEM ír a job_posts-ba. Álláshirdetést továbbra is a registry-n keresztül küldj.",
    steps: [
      "1. Ezt már meghívtad (get_ats_discovery) — a `tenants` a már ismert boardok, a `knownMisses` a már cáfolt slugok. Egyiket se küldd be újra.",
      "2. Futtasd le a `suggestedQueries` listában kapott kereséseket (naponta forognak, nem kell választanod).",
      "3. A találatokból gyűjtsd ki az ATS-HIRDETÉSLINKEKET (a supportedProviders domainjeire mutató url-eket), NEM a cégek saját karrieroldalát.",
      "4. Küldd be őket egyben (submit_ats_tenants), body: {\"urls\": [...]}.",
      "5. A válasz `added` / `alreadyKnown` / `notFound` mezőit írd bele a futás összefoglalójába.",
    ],
    rules: [
      "Kérésenként legfeljebb " + MAX_ITEMS + " elem.",
      "Cégnév-tippet (`tenants` mező) ne küldj — az `urls` alak pontosabb, mert abból a slug kiolvasható.",
      "A szerver minden beküldött slugot élesben leprobál; a nem létező boardok nem kerülnek be.",
      "A cégnevet ne találgasd: a szerver szándékosan nem tárolja a beküldött nevet a tenanton.",
    ],
    submit: {
      bodyExample: { urls: ["https://jobs.ashbyhq.com/<ceg>/<id>", "https://job-boards.greenhouse.io/<ceg>/jobs/<id>"] },
    },
  };
}

export async function getAtsDiscoverySnapshot() {
  const tenantsByKey = await readTenants();
  const tenants = Object.values(tenantsByKey)
    .map((t) => ({
      provider: t.provider,
      slug: t.slug,
      company: t.company,
      status: t.status,
      last_hu_count: t.lastHuCount,
      last_checked: t.lastChecked,
    }))
    .sort((a, b) => (a.provider === b.provider ? a.slug.localeCompare(b.slug) : a.provider.localeCompare(b.provider)));

  // A már cáfolt slugok is a memória része: enélkül a routine ugyanazt a
  // nemlétező boardot javasolná minden héten.
  const { candidates } = await readCandidateState();
  const knownMisses = Object.values(candidates)
    .filter((c) => c.status === "miss")
    .map((c) => c.slug)
    .sort()
    .slice(0, 2000);

  return {
    instructions: routineInstructions(),
    suggestedQueries: suggestedQueries(),
    queryBank: QUERY_BANK,
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
  };
}

export async function submitAtsTenants(payload) {
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
    const err = new Error(`Too many items in one request (${items.length} > ${MAX_ITEMS})`);
    err.status = 413;
    err.details = { max: MAX_ITEMS };
    throw err;
  }

  const added = [];
  const alreadyKnown = [];
  const notFound = [];

  // Egy olvasás + (csak ha valóban lett új tenant) egy írás a teljes
  // kérésre — a korábbi Postgres-verzió itemenként adott ki egy SELECT +
  // legfeljebb egy INSERT-et.
  const tenants = await readTenants();
  let dirty = false;

  for (const item of items) {
    if (tenants[tenantKey(item.provider, item.slug)]) { alreadyKnown.push(`${item.provider}:${item.slug}`); continue; }

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
    addTenantIfNew(tenants, item.provider, item.slug, {
      discoveredVia: `${item.fromUrl ? "search-url" : "search-slug"}${item.company ? `:${item.company.slice(0, 150)}` : ""}`,
    });
    dirty = true;
    added.push(`${item.provider}:${item.slug}`);
  }

  if (dirty) await writeTenants(tenants);

  return {
    submitted: items.length,
    added,
    alreadyKnown,
    notFound,
    rejected,
    note: "Added tenants are harvested by the daily ats-crawl worker; nothing is written to job_posts here.",
  };
}
