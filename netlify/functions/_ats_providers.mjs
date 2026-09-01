/*
 * ATS provider-adapterek (WEB_CRAWLER_PLAN.md §3.1, F1).
 *
 * Egy adapter = egy ATS-szolgáltató publikus, hitelesítés nélküli JSON-API-ja.
 * A cél NEM crawl: cég-slug + egy lista-hívás, és kész a teljes nyitott listája.
 * Ha egy provider formátumot vált, EGY adaptert kell javítani, nem a workert.
 *
 * Uniform interfész — minden adapter ezt adja:
 *   id                     provider-kulcs (= ats_tenants.provider)
 *   detectsMissingTenant   true, ha a nemlétező slug megkülönböztethető (404)
 *   async list(slug)       → { notFound, jobs: [AtsJob] }
 *   async detail(job)      → descriptionHtml | null   (csak ha a lista nem hozza)
 *   async companyName(slug)→ a board TULAJDONOSÁNAK neve | null   (csak azoknál
 *                            a providereknél, amelyek a hirdetés-payloadban NEM
 *                            adják meg — ld. lentebb)
 *
 * AtsJob:
 *   { title, url, location, company, descriptionHtml, detailRef }
 *   `location` MINDEN helyszínt tartalmaz egy stringben (elsődleges +
 *   másodlagos/office-lista), mert a _ats_location.mjs kapuja pont a "Budapest
 *   MELLETT van-e másik város" esetet nézi — ha csak az elsődlegeset adnánk át,
 *   egy "Budapest + Berlin" hirdetés átcsúszna.
 *
 * ── Élőben igazolt viselkedés (2026-08-26, curl + scratch-próba) ──────────
 *  • ashby / greenhouse / lever: nemlétező slug → tiszta 404 → a tenant
 *    automatikusan `dead`-re állítható.
 *  • smartrecruiters: NEM. Bármilyen kitalált slug ("prezi", "avisbudget",
 *    "4iG") 200-at ad `content: []`-tel, tehát a "nincs ilyen cég" és a
 *    "nincs nyitott állása" megkülönböztethetetlen. Ezért detectsMissingTenant
 *    = false, és üres boardra SOSEM deaktiválunk (a worker complete:false-t ad).
 *  • Cégnév: greenhouse (`company_name`) és smartrecruiters (`company.name`) a
 *    hirdetés mellé adja, ashby és lever NEM (2026-08-28: 18 ats-crawl sor
 *    maradt cégnév nélkül emiatt — a felderített tenantok `company`-ja
 *    szándékosan NULL, ld. cron_ats_discover addTenant). Ez utóbbi kettőnél a
 *    board saját nyitóoldalának <title>-je adja a nevet ("<Cég> Jobs" ashby-n,
 *    "<Cég>" leveren) — ez a board saját állítása magáról, nem a mi tippünk a
 *    cégnévből képzett slugra, tehát tényként kezelhető. A worker tenantonként
 *    EGYSZER kéri le és elmenti az ats_tenants sorba.
 *  • A leíráshoz NEM kell külön kör ashby/lever esetén (a lista hozza), viszont
 *    greenhouse/smartrecruiters esetén igen — ott EGY detail-fetch/sor, a
 *    HU-szűrés UTÁN, insert ELŐTT (experience-write-policy: a sor teljesen
 *    összeáll az insert előtt, külön fetch-then-UPDATE nincs).
 */

const UA = "JobWatcher/1.0 (+https://bakan7.netlify.app)";
const FETCH_TIMEOUT_MS = 20000;

class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} for ${url}`);
    this.status = status;
  }
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "application/json,text/plain;q=0.9,*/*;q=0.8",
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new HttpError(res.status, url);
  return res.json();
}

async function fetchJsonPost(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "content-type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new HttpError(res.status, url);
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html,*/*;q=0.8" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new HttpError(res.status, url);
  return res.text();
}

/*
 * A board nyitóoldalának <title>-jéből olvassa ki a cég nevét.
 * `suffixRe` = a provider állandó toldaléka ("… Jobs"), amit le kell vágni.
 * Nem létező boardnál ez pont üres nevet ad (ashby: "<title>Jobs</title>"),
 * ezért a levágás UTÁNI üres string = nincs név, nem pedig névtelen cég.
 */
async function companyFromBoardTitle(url, suffixRe) {
  let html;
  try {
    html = await fetchText(url);
  } catch {
    return null;
  }
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return null;
  const name = clean(decodeEntities(m[1])).replace(suffixRe, "").trim();
  if (!name || /^not found/i.test(name)) return null;
  return name.slice(0, 200);
}

// A Greenhouse `content` mezője HTML-ENTITÁSKÉNT kódolt HTML-t ad vissza
// ("&lt;div&gt;…"), nem nyers HTML-t — dekódolás nélkül az extractTechnologies
// és az extractBodyExperience egyetlen szót sem találna meg benne.
function decodeEntities(s) {
  return String(s ?? "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function joinLocations(...parts) {
  return parts
    .flat(Infinity)
    .map((p) => String(p ?? "").trim())
    .filter(Boolean)
    .join(" | ");
}

function clean(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

/* ── Ashby ────────────────────────────────────────────────────────────
   Lista: minden mező egy körben (descriptionHtml is), így nulla detail-fetch.
   `isListed:false` = a board nem mutatja (levett/vázlat) → kihagyjuk. */
const ashby = {
  id: "ashby",
  detectsMissingTenant: true,
  async list(slug) {
    let data;
    try {
      data = await fetchJson(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}`);
    } catch (err) {
      if (err.status === 404) return { notFound: true, jobs: [] };
      throw err;
    }
    const jobs = (data?.jobs || [])
      .filter((j) => j && j.isListed !== false && j.jobUrl && j.title)
      .map((j) => ({
        title: clean(j.title),
        url: j.jobUrl,
        location: joinLocations(
          j.location,
          (j.secondaryLocations || []).map((l) => (typeof l === "string" ? l : l?.location))
        ),
        company: null, // a board nem hozza — a tenant rekordból jön
        descriptionHtml: j.descriptionHtml || null,
        detailRef: null,
      }));
    return { notFound: false, jobs };
  },
  async detail() { return null; },
  async companyName(slug) {
    return companyFromBoardTitle(
      `https://jobs.ashbyhq.com/${encodeURIComponent(slug)}`,
      /\s*jobs$/i
    );
  },
};

/* ── Greenhouse ───────────────────────────────────────────────────────
   A lista alapból leírás NÉLKÜL jön; `?content=true` beletenné, de egy 451
   állásos boardnál (datadog) az több MB feleslegesen. Ezért lista → HU-szűrés
   → csak a megmaradt sorokra egy-egy detail-hívás. */
/** A sor url-je: a Greenhouse-on hosztolt board-url, NEM a cég saját domainje.
 *
 *  Az `absolute_url` ott, ahol a cég beállított saját „job post url"-t, a cég
 *  oldalára mutat (`tulip.co/careers/job-posting/?gh_jid=…`,
 *  `www.taboola.com/careers/job/<id>?gh_jid=…`). Ez ugyanaz a hibaosztály,
 *  amit a recruitee adapter is kerül: az ilyen url első path-szegmense nem a
 *  tenant slugja, tehát deriveScopePrefix null-t ad → a reconcile azon a
 *  tenanton ÖRÖKRE reactivate-only marad, a cég saját oldala pedig egy törölt
 *  hirdetésre is 200-at ad, tehát a napi sweep sem viszi el. 2026-09-01-én ez
 *  150 aktív ats-crawl sorból 41-et hagyott mindenféle deaktiválási út nélkül,
 *  köztük 4 igazoltan halottat (per-job API 404, napok óta nyitva).
 *
 *  A kanonikus alak mindkét lyukat betömi: egységes `/{slug}/` előtagot ad a
 *  reconcile-nak, és a SWEEP_PROBE_OVERRIDES boards-api próbája is felismeri.
 *  Élőben mérve 2026-09-01: élő hirdetésnél 302-vel a cég saját oldalára visz
 *  (a felhasználó ugyanoda jut), halottnál a board `?error=true`-jára — amit az
 *  _ai_liveness.mjs külön szabálya is halálnak vesz. A US host az EU-boardokat
 *  is kiszolgálja (abbyy: 200), de a MÁR greenhouse-on hosztolt url-eket
 *  érintetlenül hagyjuk, különben a meglévő job-boards.eu.greenhouse.io sorok
 *  mind új url-t, azaz új sort kapnának. */
function greenhouseJobUrl(slug, job) {
  if (!job.id) return job.absolute_url;
  try {
    if (/(^|\.)greenhouse\.io$/.test(new URL(job.absolute_url).hostname)) return job.absolute_url;
  } catch {
    // Nem parse-olható url → a kanonikus alak úgyis jobb.
  }
  return `https://job-boards.greenhouse.io/${encodeURIComponent(slug)}/jobs/${job.id}`;
}

const greenhouse = {
  id: "greenhouse",
  detectsMissingTenant: true,
  async list(slug) {
    let data;
    try {
      data = await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs`);
    } catch (err) {
      if (err.status === 404) return { notFound: true, jobs: [] };
      throw err;
    }
    const jobs = (data?.jobs || [])
      .filter((j) => j && j.absolute_url && j.title)
      .map((j) => ({
        title: clean(j.title),
        url: greenhouseJobUrl(slug, j),
        location: joinLocations(j?.location?.name, (j.offices || []).map((o) => o?.name)),
        company: clean(j.company_name) || null,
        descriptionHtml: null,
        detailRef: `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs/${j.id}`,
      }));
    return { notFound: false, jobs };
  },
  async detail(job) {
    const d = await fetchJson(job.detailRef);
    return d?.content ? decodeEntities(d.content) : null;
  },
};

/* ── Lever ────────────────────────────────────────────────────────────
   Egy körben minden. A leírás több mezőre van szétvágva (description /
   lists / additional) — összefűzzük, különben a követelmény-lista (ahol a
   technológiák és az évszámok élnek) kimaradna. */
const lever = {
  id: "lever",
  detectsMissingTenant: true,
  async list(slug) {
    let data;
    try {
      data = await fetchJson(`https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`);
    } catch (err) {
      if (err.status === 404) return { notFound: true, jobs: [] };
      throw err;
    }
    const jobs = (Array.isArray(data) ? data : [])
      .filter((j) => j && j.hostedUrl && j.text)
      .map((j) => ({
        title: clean(j.text),
        url: j.hostedUrl,
        location: joinLocations(
          j?.categories?.allLocations,
          j?.categories?.location,
          j?.country
        ),
        company: null,
        descriptionHtml: [
          j.description,
          ...(j.lists || []).map((l) => `${l?.text || ""} ${l?.content || ""}`),
          j.additional,
        ].filter(Boolean).join(" ") || null,
        detailRef: null,
      }));
    return { notFound: false, jobs };
  },
  async detail() { return null; },
  async companyName(slug) {
    return companyFromBoardTitle(
      `https://jobs.lever.co/${encodeURIComponent(slug)}`,
      /\s*jobs$/i
    );
  },
};

/* ── SmartRecruiters ──────────────────────────────────────────────────
   100-as lapokban jön, `totalFound`-ig lapozunk (ugyanaz a szerződés, amit a
   cron_jobs_ATS-background.mjs már használ). A sor URL-je a detail-válasz
   `postingUrl`-je, nem a lista-elem — ez tartalmazza a rotáló numerikus id-t,
   amit a worker migrateVolatileUrl-lel kezel.

   FONTOS, `applyUrl` HELYETT (2026-09-01): a két mező ugyanaz az url, csak az
   `applyUrl` végén ott az `?oga=true`, ami 302-vel a /oneclick-ui/… JELENTKEZÉSI
   űrlapra visz — a hirdetés szövegét el sem lehet olvasni róla. A
   cron_jobs_ATS-background.mjs ezt eddig is levágta a saját normalizeUrl-jében
   (`oga` a tracking-listáján), az itteni közös normalizeUrl viszont nem, ezért
   az ats-crawl sorok a jelentkezési oldalra mutattak. */
/** A hirdetés-oldal url-je. `postingUrl` az elsődleges; ha csak `applyUrl` van,
 *  levágjuk róla az `oga` kapcsolót, hogy ne a jelentkezési űrlapra mutasson. */
function srPostingUrl(d) {
  if (d?.postingUrl) return d.postingUrl;
  if (!d?.applyUrl) return null;
  try {
    const u = new URL(d.applyUrl);
    u.searchParams.delete("oga");
    return u.toString().replace(/\?$/, "");
  } catch {
    return d.applyUrl;
  }
}

const SR_PAGE_SIZE = 100;
const SR_MAX_PAGES = 30;

const smartrecruiters = {
  id: "smartrecruiters",
  // Élőben igazolt: kitalált slugra is 200 + üres content (lásd a fejlécet).
  detectsMissingTenant: false,
  async list(slug) {
    const all = [];
    for (let page = 0; page < SR_MAX_PAGES; page += 1) {
      const url =
        `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings` +
        `?limit=${SR_PAGE_SIZE}&offset=${page * SR_PAGE_SIZE}`;
      let payload;
      try {
        payload = await fetchJson(url);
      } catch (err) {
        if (err.status === 404) return { notFound: true, jobs: [] };
        throw err;
      }
      const content = Array.isArray(payload?.content) ? payload.content : [];
      all.push(...content);
      const totalFound = Number(payload?.totalFound ?? 0);
      if (content.length < SR_PAGE_SIZE) break;
      if (totalFound && all.length >= totalFound) break;
    }
    const jobs = all
      .filter((j) => j && j.name && j.ref)
      .map((j) => ({
        title: clean(j.name),
        // A végleges url a detail postingUrl-je; a lista-elem `ref`-je csak API-cím.
        url: null,
        location: joinLocations(j?.location?.city, j?.location?.region, j?.location?.country, j?.location?.fullLocation),
        company: clean(j?.company?.name) || null,
        descriptionHtml: null,
        detailRef: j.ref,
      }));
    return { notFound: false, jobs };
  },
  async detail(job) {
    const d = await fetchJson(job.detailRef);
    const sections = d?.jobAd?.sections;
    const html = sections
      ? [sections.jobDescription?.text, sections.qualifications?.text].filter(Boolean).join(" ") || null
      : null;
    // A detail adja a nyilvános url-t is — a worker ezt írja vissza a sorba.
    // postingUrl = maga a hirdetés-oldal; applyUrl = ugyanaz `?oga=true`-val,
    // ami a jelentkezési űrlapra redirectel. Tartalék ágon levágjuk az `oga`-t.
    return { html, url: srPostingUrl(d) };
  },
};

/* ── Recruitee ────────────────────────────────────────────────────────
   Élőben igazolt 2026-08-30:
    • `https://<slug>.recruitee.com/api/offers/` — egy körben MINDEN mező,
      leírással (`description` + `requirements`) és cégnévvel (`company_name`)
      együtt, tehát NULLA detail-hívás és nincs szükség companyName()-re sem.
    • Nemlétező tenant → tiszta 404 (`{"error":"Not Found"}`), tehát
      detectsMissingTenant = true és a slug-tippelés is működik rajta.
    • A sor url-je NEM a payload `careers_url`-je: az a cég SAJÁT domainjére
      mutat, ha be van állítva ("https://karrier.blackbelt.hu/o/…",
      "https://careers.tellent.com/o/…"). Az pont az a hibaosztály, ami a
      cég-domainre mutató Greenhouse-boardoknál egységes url-előtag nélkül
      hagyja a reconcile-t (2026-08-30-i elemzés: 8 tenant, 30 sor deaktiválási
      út nélkül). Helyette a kanonikus `<slug>.recruitee.com/o/<hirdetés-slug>`
      alakot építjük: tenant-scope-os, egységes előtagot ad, és élő méréssel
      egyenértékű a cég-domainnel — ahol van saját domain, ott 302-vel oda
      irányít ÚTVONAL-tartással (élő hirdetés → 200, halott → 404), tehát a
      napi 404-sweep is helyesen dönt rajta.
    • Ismert korlát: a hirdetés-slug a cím átírásakor VÁLTOZHAT, és nincs
      publikus id/guid-alapú url (mindhárom alakot próbáltam, 404) — egy
      átnevezés tehát új sort szül, a régi url pedig 404-re fut és a sweep
      viszi el. Nem tudunk migrateVolatileUrl-mintát adni rá, mert az url-ben
      nincs stabil rész. */
const recruitee = {
  id: "recruitee",
  detectsMissingTenant: true,
  async list(slug) {
    // A slug itt HOSTNÉV-részlet lesz, nem útvonal — egy furcsa karakter nem
    // escape-elhető, hanem értelmetlen hostot adna. A nem slug-alakú érték
    // ugyanaz, mint a nemlétező board: nincs mit learatni.
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(String(slug))) return { notFound: true, jobs: [] };
    let data;
    try {
      data = await fetchJson(`https://${slug}.recruitee.com/api/offers/`);
    } catch (err) {
      if (err.status === 404) return { notFound: true, jobs: [] };
      throw err;
    }
    const jobs = (data?.offers || [])
      .filter((o) => o && o.title && o.slug && (!o.status || o.status === "published"))
      .map((o) => ({
        title: clean(o.title),
        url: `https://${slug}.recruitee.com/o/${o.slug}`,
        // MINDEN helyszín egy stringbe: a `location` mező távmunkánál csak
        // "Remote job", a valódi városok a `locations[]`-ben ülnek (élő
        // példa: loc="Remote job", locations = Amsterdam + Germany + Poland).
        // Enélkül egy ilyen sor helyszín-információ nélkül maradna.
        location: joinLocations(
          o.city,
          o.state_name,
          o.country,
          o.location,
          (o.locations || []).map((l) => [l?.city, l?.name, l?.state, l?.country])
        ),
        company: clean(o.company_name) || null,
        descriptionHtml: [o.description, o.requirements].filter(Boolean).join(" ") || null,
        detailRef: null,
      }));
    return { notFound: false, jobs };
  },
  async detail() { return null; },
};

/* ── Workday ──────────────────────────────────────────────────────────
   A budapesti nagyvállalati/SSC-réteg ATS-e: a saját `job_posts`-unkban 23
   különböző myworkdayjobs.com tenant szerepel (Morgan Stanley, Mastercard,
   Accenture, Genesys, Sanofi, Genpact, GoTo, Silicon Labs, NN, PwC, DXC,
   Kyndryl, Aegon GBSC, TAKKT, …) — mind olyan cég, amelyik bizonyítottan
   hirdet Budapesten, de eddig csak közvetve (LinkedIn / AI-scraped) láttuk.

   Élő mérés 2026-08-30:
    • Lista: POST `/wday/cxs/<tenant>/<site>/jobs`, törzs
      `{appliedFacets, limit, offset, searchText}` — hitelesítés nélkül.
      A `limit` MAXIMUM 20 (50 és 100 → HTTP 400), `offset`-tel lapozható.
    • ORSZÁG-SZŰRŐ SZERVEROLDALON: a válasz `facets` fája tartalmaz egy
      ország-facetet, és **a Magyarország id-ja tenantfüggetlen konstans**
      (`9db257f5…`) — négy külön tenanten ugyanaz. A facet PARAMÉTER-NEVE
      viszont tenantonként más (`locationCountry` vs `Location_Country`),
      ezért a nevet MINDIG a válaszból olvassuk ki, sosem hardcode-oljuk.
      Ezzel egy 2000 állásos boardból (accenture) 33 sort kérünk le, nem 2000-et.
    • A lista `locationsText`-je megbízhatatlan: van, hogy "2 Locations"
      (több telephely), és van, hogy hiányzik (accenture: undefined). Ezért az
      ilyen sorokra MÁR A LISTÁZÁSKOR lehívjuk a detailt, és a
      `location` + `additionalLocations` mezőkből rakjuk össze a teljes
      helyszín-szöveget — különben a fail-closed helyszín-kapu vagy tévesen
      eldobná őket, vagy (rosszabb) egy Stuttgart+Budapest hirdetést
      budapestiként engedne be. A detail válaszát cache-eljük, hogy a
      leírásért ne kelljen másodszor is elmenni.
    • Halott hirdetés → tiszta 404 a detail-endpointon, tehát a napi
      404-sweep is helyesen dönt.
    • Nemlétező tenant → 422, rossz site → 404. Mindkettő "nincs ilyen board":
      a kérés törzse állandó, tehát a 422 nem a mi hibánk, hanem a hosté.

   Ismert korlát: a hirdetés url-je tartalmazza a címből képzett szeletet
   (`/job/Budapest/Java-Developer_JR123`), tehát átnevezéskor változik, és
   nincs stabil id-alapú publikus url — ugyanaz a churn-kockázat, mint a
   recruitee-nél (a régi url 404-re fut, a sweep viszi el).

   A tenant-slug HÁROM adatot köt össze, mert mindhárom kell a híváshoz:
       "<tenant>.<wdN>:<site>"        pl. "ms.wd5:External"
   Mindhárom kiolvasható egy hirdetés url-jéből (parseAtsUrl), tehát a
   felderítéshez nem kell találgatni — viszont épp ezért NEM is tippelhető,
   így a workday szándékosan kimarad a PROBEABLE_PROVIDERS-ből. */
const WORKDAY_HU_COUNTRY_ID = "9db257f5937e4421b2fac64eec6832f8";
const WD_PAGE = 20;          // a szerver által engedett maximum
const WD_MAX_PAGES = 15;     // 300 magyar sor/tenant plafon — bőven a mért 57 fölött
const WD_SLUG_RE = /^([a-z0-9][a-z0-9-]*)\.(wd\d+):([A-Za-z0-9_-]+)$/i;

export function parseWorkdaySlug(slug) {
  const m = WD_SLUG_RE.exec(String(slug ?? "").trim());
  if (!m) return null;
  return { tenant: m[1].toLowerCase(), wd: m[2].toLowerCase(), site: m[3] };
}

function workdayBase({ tenant, wd, site }) {
  return `https://${tenant}.${wd}.myworkdayjobs.com/wday/cxs/${tenant}/${site}`;
}

function workdayPublicBase({ tenant, wd, site }) {
  return `https://${tenant}.${wd}.myworkdayjobs.com/en-US/${site}`;
}

/* A facet-fa mélységben keresi a magyar országértéket. A találat PARAMÉTER-neve
   a szülő csomópont `facetParameter`-e, nem a levélé — ezért adjuk tovább. */
function findHungaryFacet(nodes, param) {
  for (const n of nodes || []) {
    const isHu = n?.id === WORKDAY_HU_COUNTRY_ID || /^hungary$/i.test(n?.descriptor || "");
    if (isHu && n?.id && param) return { param, id: n.id, count: n.count ?? null };
    const deeper = findHungaryFacet(n?.values, n?.facetParameter || param);
    if (deeper) return deeper;
  }
  return null;
}

// "2 Locations" / "3 Locations" / üres → a lista nem mondja meg a helyszínt.
function workdayLocationIsAmbiguous(text) {
  const t = clean(text);
  return !t || /^\d+\s+locations?$/i.test(t);
}

const workday = {
  id: "workday",
  detectsMissingTenant: true,
  async list(slug) {
    const parts = parseWorkdaySlug(slug);
    if (!parts) return { notFound: true, jobs: [] };
    const base = workdayBase(parts);
    const publicBase = workdayPublicBase(parts);

    const ask = (appliedFacets, offset) =>
      fetchJsonPost(`${base}/jobs`, { appliedFacets, limit: WD_PAGE, offset, searchText: "" });

    let first;
    try {
      first = await ask({}, 0);
    } catch (err) {
      // 404 = nincs ilyen site, 422 = nincs ilyen tenant (élőben mérve).
      if (err.status === 404 || err.status === 422) return { notFound: true, jobs: [] };
      throw err;
    }

    const hu = findHungaryFacet(first?.facets, null);
    // Nincs magyar facet-érték = a boardon jelenleg nincs magyar hirdetés. Ez
    // NEM "nincs ilyen board", és nem is deaktiválási ok: üres eredménnyel a
    // worker complete:false-t ad, a halott sorokat a 404-sweep viszi el.
    if (!hu) return { notFound: false, jobs: [] };

    const applied = { [hu.param]: [hu.id] };
    const raw = [];
    for (let page = 0; page < WD_MAX_PAGES; page += 1) {
      const payload = page === 0 ? await ask(applied, 0) : await ask(applied, page * WD_PAGE);
      const batch = payload?.jobPostings || [];
      raw.push(...batch);
      const total = Number(payload?.total ?? 0);
      if (batch.length < WD_PAGE) break;
      if (total && raw.length >= total) break;
    }

    const jobs = [];
    for (const j of raw) {
      if (!j?.title || !j?.externalPath) continue;
      const detailRef = `${base}/job${String(j.externalPath).replace(/^\/job/, "")}`;
      let location = clean(j.locationsText);
      let cachedHtml = null;
      if (workdayLocationIsAmbiguous(location)) {
        try {
          const info = (await fetchJson(detailRef))?.jobPostingInfo;
          location = joinLocations(info?.location, info?.additionalLocations);
          cachedHtml = info?.jobDescription || null;
        } catch {
          // Marad a lista bizonytalan szövege; a "| Hungary" utótag miatt a
          // kapu nem dobja el pusztán amiatt, hogy nincs városnév.
        }
      }
      jobs.push({
        title: clean(j.title),
        url: `${publicBase}${j.externalPath}`,
        // Az ország-facet GARANTÁLJA, hogy ez magyar hirdetés, tehát a
        // "Hungary" itt tény, nem feltételezés — enélkül a fail-closed kapu
        // minden olyan sort eldobna, aminek a szövegében csak a városnév van.
        location: joinLocations(location, "Hungary"),
        company: null, // a payload nem hozza — az ats_tenants sorból jön
        descriptionHtml: null,
        detailRef,
        _html: cachedHtml,
      });
    }
    return { notFound: false, jobs };
  },
  async detail(job) {
    if (job?._html) return job._html;
    const d = await fetchJson(job.detailRef);
    return d?.jobPostingInfo?.jobDescription || null;
  },
  /* A tenantot NEM az útvonal első szegmense azonosítja (az "en-US"), hanem a
     host + a site együtt — és a site-ot muszáj beleérteni, különben ugyanannak
     a cégnek egy másik site-ja alá tartozó sorokat is deaktiválna ez a
     reconcile (DEACTIVATION_AUDIT Cat-5). */
  scopePrefix(slug, urls) {
    const parts = parseWorkdaySlug(slug);
    if (!parts) return null;
    const prefix = `${workdayPublicBase(parts)}/`;
    const list = (urls || []).filter(Boolean);
    if (list.length === 0) return null;
    return list.every((u) => String(u).startsWith(prefix)) ? prefix : null;
  },
};

/* ── Personio ─────────────────────────────────────────────────────────
   Élő mérés 2026-08-30:
    • Lista: `https://<slug>.jobs.personio.com/xml` — publikus XML-feed, egy
      körben MINDEN pozícióval ÉS a teljes leírással (`jobDescriptions`
      CDATA-blokkok), tehát nulla detail-hívás. A `.de` és a `.com` host
      bájtra ugyanazt adja (mindkettő mérve, több tenanton) — a `.com`-ot
      használjuk, mert a saját meglévő sorunk is azon van (teliogroup).
    • Halott hirdetés → tiszta 404 (`/job/<id>`), és az `id` STABIL: a url-ben
      nincs címből képzett szelet, tehát átnevezéskor sem churn-ölünk. Ez a
      recruitee/workday ismert korlátjának pont az ellentéte.
    • **Nemlétező tenant → 429**, nem 404 (ismeretlen aldomain-válasz, nem
      throttling: ugyanabban a másodpercben egy létező tenant 200-at adott).
      Ez így is kétértelmű marad — egy VALÓDI rate limit ugyanezt adná —,
      ezért `detectsMissingTenant: false`: ebből a forrásból sosem jelölünk
      tenantot halottnak. A slug-tippelés viszont használhatja cáfolatként
      (ld. _ats_slug_core.mjs PROBE_MISS_STATUS).
    • Magyar jelenlét igazolva: 76 magyar cég-slugból 2 találat (teliogroup =
      Telio Group / BVfon, Budapest; szallas = Szállás Group, Miskolc/Cluj).

   A `subcompany` a hirdetést valóban feladó jogi entitás neve (pl. "BVfon
   Telekommunikációs Kft."), tehát cégnévnek jobb, mint a tenant-slugból
   képzett tipp — ha üres, marad az ats_tenants sor neve. */
const PERSONIO_HOST = (slug) => `https://${slug}.jobs.personio.com`;

function xmlTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i"));
  if (!m) return "";
  // Az XML-feed entitáskódolva adja a szöveget ("Cloud &amp; Edge") — dekódolás
  // nélkül a cím így is menne a job_posts-ba, és a listán is így látszana.
  return clean(decodeEntities(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")));
}

const personio = {
  id: "personio",
  // 429 = "nincs ilyen tenant" ÉS "lassíts" is lehet — nem dönthetünk róla.
  detectsMissingTenant: false,
  async list(slug) {
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(String(slug))) return { notFound: true, jobs: [] };
    let xml;
    try {
      xml = await fetchText(`${PERSONIO_HOST(slug)}/xml`);
    } catch (err) {
      if (err.status === 404 || err.status === 429) return { notFound: true, jobs: [] };
      throw err;
    }
    if (!xml.includes("<position>")) return { notFound: false, jobs: [] };

    const jobs = [];
    for (const block of xml.match(/<position>[\s\S]*?<\/position>/g) || []) {
      const id = xmlTag(block, "id");
      const title = xmlTag(block, "name");
      if (!id || !title) continue;
      // A leírás több nevesített szakaszra van bontva (<jobDescription><name>
      // + <value>): a technológia- és évszám-kinyeréshez az ÖSSZES kell, mert
      // a követelmény-lista tipikusan egy külön szakasz.
      const descriptions = [...block.matchAll(/<value>([\s\S]*?)<\/value>/gi)]
        .map((m) => m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1"))
        .join(" ");
      jobs.push({
        title,
        url: `${PERSONIO_HOST(slug)}/job/${id}`,
        // CSAK az `office` — a `department` szándékosan nem megy bele: egy
        // "Hungary Operations" nevű részleg hamis HU-jelzést adna a
        // fail-closed kapunak, egy "Germany Sales" pedig hamis kizárást.
        location: xmlTag(block, "office"),
        company: xmlTag(block, "subcompany") || null,
        descriptionHtml: descriptions || null,
        detailRef: null,
      });
    }
    return { notFound: false, jobs };
  },
  async detail() { return null; },
};

/* ── BambooHR ─────────────────────────────────────────────────────────
   Élő mérés 2026-09-01 (curl, valós ügyfél-tenant: amacon):
    • Lista: `https://<slug>.bamboohr.com/careers/list` — publikus, hitelesítés
      nélküli JSON, EGY körben az összes nyitott pozícióval (`meta.totalCount`
      == a `result` tömb hossza, nincs lapozás). A leírás NEM jön vele.
    • Detail: `https://<slug>.bamboohr.com/careers/<id>/detail` — a teljes
      leírás NYERS HTML-ként (nem entitáskódolva, ellentétben a greenhouse-zal),
      tehát decodeEntities nem kell rá.
    • Nemlétező tenant: a `careers/list` NEM 404-et ad, hanem 302-t a
      `https://www.bamboohr.com` marketingoldalra (`redirect:"manual"`-lal
      igazolva — automata redirect-követéssel ez egy 200 HTML lenne, tehát a
      `res.json()` values félrevezető hibával bukna). Ezért a lista-hívás
      MANUÁLIS redirect-tel megy, és bármilyen 3xx = nincs ilyen tenant.
    • Nemlétező job-id VALÓDI tenanton viszont tiszta 404 JSON-t ad a detail-
      végponton (`{"type":"not_found",...}`) — ott a megszokott HttpError-ág jó.
    • Cégnév: a payload nem hozza; a `<slug>.bamboohr.com/careers` oldal
      `og:site_name` meta tagje adja pontosan (élőben igazolt: "Amacon"). */
const BAMBOOHR_FETCH_TIMEOUT = FETCH_TIMEOUT_MS;

async function bamboohrListRaw(slug) {
  const res = await fetch(`https://${encodeURIComponent(slug)}.bamboohr.com/careers/list`, {
    redirect: "manual",
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(BAMBOOHR_FETCH_TIMEOUT),
  });
  // 3xx = a nemlétező tenant a marketingoldalra redirectel — sosem a board maga.
  if (res.status >= 300 && res.status < 400) return null;
  if (!res.ok) throw new HttpError(res.status, res.url);
  return res.json();
}

function companyFromMeta(html, property) {
  const re = new RegExp(`<meta[^>]*property=["']${property}["'][^>]*content=["']([^"']*)["']`, "i");
  const m = html.match(re);
  if (!m) return null;
  const name = clean(decodeEntities(m[1]));
  return name || null;
}

async function companyFromOgSiteName(url) {
  let html;
  try {
    html = await fetchText(url);
  } catch {
    return null;
  }
  return companyFromMeta(html, "og:site_name");
}

const bamboohr = {
  id: "bamboohr",
  detectsMissingTenant: true,
  async list(slug) {
    const data = await bamboohrListRaw(slug);
    if (data === null) return { notFound: true, jobs: [] };
    const jobs = (data?.result || [])
      .filter((j) => j && j.id && j.jobOpeningName)
      .map((j) => ({
        title: clean(j.jobOpeningName),
        url: `https://${encodeURIComponent(slug)}.bamboohr.com/careers/${j.id}`,
        location: joinLocations(j?.location?.city, j?.location?.state),
        company: null,
        descriptionHtml: null,
        detailRef: `https://${encodeURIComponent(slug)}.bamboohr.com/careers/${j.id}/detail`,
      }));
    return { notFound: false, jobs };
  },
  async detail(job) {
    const d = await fetchJson(job.detailRef);
    return d?.result?.jobOpening?.description || null;
  },
  async companyName(slug) {
    return companyFromOgSiteName(`https://${encodeURIComponent(slug)}.bamboohr.com/careers`);
  },
};

/* ── Teamtailor ───────────────────────────────────────────────────────
   Élő mérés 2026-09-01 (curl, valós magyar tenant: kpmgglobalservices):
    • NINCS publikus JSON lista-API kulcs nélkül (a hivatalos api.teamtailor.com
      céges API-tokent kér) — a `/jobs` oldal viszont szerveroldalon renderelt
      HTML (nem puszta SPA-shell), és a hirdetés-linkek (`/jobs/<id>-<szlug>`)
      MINDIG jelen vannak benne, mert ez routing, nem téma. A lista-kártya
      körüli szöveg (cím + részleg + helyszín) a beépített "Jobs list" blokk
      markup-ja — ha egy tenant más blokk-elrendezést használ, a `title`/
      `location` mezők üresen maradnak ARRA a tenantra, ami fail-closed módon
      egyszerűen "nincs magyar hirdetés"-ként landol (ld. _ats_location.mjs),
      nem hibázik és nem hoz be szemetet.
    • A hirdetés-oldal FEJLÉCÉBEN van egy szabványos schema.org JobPosting
      `application/ld+json` blokk — ez SEO-metaadat, a témától függetlenül
      stabil. `hiringOrganization.name`-je a cégnév, `description`-je a teljes
      leírás (entitáskódolt HTML, mint a greenhouse `content`-je). A nyers
      JSON-ban a leírás-mezőben literál sortörések vannak (nem `\n`-escape-elve)
      → `JSON.parse` control-character hibával bukna, ezért a sortörést előbb
      szóközre cseréljük.
    • Nemlétező tenant → tiszta 404 a `/jobs` oldalon (élőben igazolt).
    • Cégnév a listaoldal `og:site_name` meta tagjéből (ugyanaz a minta, mint
      BambooHR-nél) — nem kell külön JSON-LD-fetch a cégnév-feloldáshoz. */
const TT_JOB_LINK_RE = /href="(https:\/\/[a-z0-9-]+\.teamtailor\.com\/jobs\/(\d+)-([a-z0-9-]+))"/gi;
const TT_META_DIV_RE = /class="[^"]*mt-1 text-md[^"]*">([\s\S]*?)<\/div>/;
const TT_TITLE_ATTR_RE = /title="([^"]+)"/;
const TT_ALT_IMG_RE = /alt="([^"]+?)\s*image"/i;

function teamtailorParseListing(html) {
  const matches = [...html.matchAll(TT_JOB_LINK_RE)];
  const seen = new Set();
  const jobs = [];
  for (let i = 0; i < matches.length; i += 1) {
    const m = matches[i];
    const id = m[2];
    if (seen.has(id)) continue;
    seen.add(id);
    const start = m.index;
    const end = i + 1 < matches.length ? matches[i + 1].index : Math.min(html.length, start + 4000);
    const segment = html.slice(start, end);
    const titleAttr = segment.match(TT_TITLE_ATTR_RE);
    const altImg = segment.match(TT_ALT_IMG_RE);
    const title = titleAttr
      ? clean(decodeEntities(titleAttr[1]))
      : (altImg ? clean(decodeEntities(altImg[1])) : null);
    const metaDiv = segment.match(TT_META_DIV_RE);
    const location = metaDiv
      ? clean(decodeEntities(metaDiv[1].replace(/<[^>]+>/g, " ").replace(/&middot;/g, " ")))
      : "";
    jobs.push({ url: m[1], title, location });
  }
  return jobs;
}

function teamtailorExtractJobPosting(html) {
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  for (const b of blocks) {
    const raw = b[1].replace(/[\r\n\t]+/g, " ");
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      continue;
    }
    if (data && data["@type"] === "JobPosting") return data;
  }
  return null;
}

const teamtailor = {
  id: "teamtailor",
  detectsMissingTenant: true,
  async list(slug) {
    let html;
    try {
      html = await fetchText(`https://${encodeURIComponent(slug)}.teamtailor.com/jobs`);
    } catch (err) {
      if (err.status === 404) return { notFound: true, jobs: [] };
      throw err;
    }
    const jobs = teamtailorParseListing(html)
      .filter((j) => j.title && j.url)
      .map((j) => ({
        title: j.title,
        url: j.url,
        location: j.location,
        company: null,
        descriptionHtml: null,
        detailRef: j.url,
      }));
    return { notFound: false, jobs };
  },
  async detail(job) {
    let html;
    try {
      html = await fetchText(job.detailRef);
    } catch {
      return null;
    }
    const posting = teamtailorExtractJobPosting(html);
    return posting?.description ? decodeEntities(String(posting.description)) : null;
  },
  async companyName(slug) {
    return companyFromOgSiteName(`https://${encodeURIComponent(slug)}.teamtailor.com/jobs`);
  },
};

export const PROVIDERS = {
  ashby, greenhouse, lever, smartrecruiters, recruitee, workday, personio, bamboohr, teamtailor,
};

export const PROVIDER_IDS = Object.keys(PROVIDERS);

export function getProvider(id) {
  return PROVIDERS[id] || null;
}

/**
 * A tenant sorainak URL-előtagja a scope-olt reconcile-hoz.
 *
 * NEM hardcode-olt minta: a ténylegesen visszakapott url-ekből vezetjük le, és
 * csak akkor adunk vissza előtagot, ha MINDEGYIK url ugyanarra az originre és
 * `/{slug}/` útvonalra esik. Egy hardcode-olt host előbb-utóbb mellémenne
 * (a Greenhouse hol `boards.greenhouse.io`-t, hol `job-boards.greenhouse.io`-t
 * ad, és egyes tenantok saját domaint használnak), és a rossz előtag néma
 * deaktiválás-kimaradást okozna. Ha nem egységes, a hívó complete:false-szal
 * kihagyja a deaktiválást — fail-safe irány.
 *
 * @returns {string|null} pl. "https://jobs.ashbyhq.com/shapr3d/"
 */
export function deriveScopePrefix(slug, urls) {
  const list = (urls || []).filter(Boolean);
  if (list.length === 0) return null;
  const wanted = String(slug).toLowerCase();
  let prefix = null;
  for (const raw of list) {
    let u;
    try {
      u = new URL(raw);
    } catch {
      return null;
    }
    const seg = u.pathname.split("/").filter(Boolean)[0];
    if (!seg) return null;
    // A tenantot vagy az ÚTVONAL első szegmense azonosítja
    // (ashby/greenhouse/lever: jobs.ashbyhq.com/<slug>/…), vagy a HOST első
    // címkéje (recruitee: <slug>.recruitee.com/o/<hirdetés>). Utóbbinál az
    // előtag ugyanúgy egy tenantra szűkít, mert maga a host tenant-specifikus.
    const hostLabel = u.hostname.split(".")[0].toLowerCase();
    if (seg.toLowerCase() !== wanted && hostLabel !== wanted) return null;
    const candidate = `${u.origin}/${seg}/`;
    if (prefix === null) prefix = candidate;
    else if (prefix !== candidate) return null;
  }
  return prefix;
}
