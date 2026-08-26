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
};

/* ── Greenhouse ───────────────────────────────────────────────────────
   A lista alapból leírás NÉLKÜL jön; `?content=true` beletenné, de egy 451
   állásos boardnál (datadog) az több MB feleslegesen. Ezért lista → HU-szűrés
   → csak a megmaradt sorokra egy-egy detail-hívás. */
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
        url: j.absolute_url,
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
};

/* ── SmartRecruiters ──────────────────────────────────────────────────
   100-as lapokban jön, `totalFound`-ig lapozunk (ugyanaz a szerződés, amit a
   cron_jobs_ATS-background.mjs már használ). A sor URL-je a detail-válasz
   `applyUrl`-je, nem a lista-elem — ez tartalmazza a rotáló numerikus id-t,
   amit a worker migrateVolatileUrl-lel kezel. */
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
        // A végleges url a detail applyUrl-je; a lista-elem `ref`-je csak API-cím.
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
    return { html, url: d?.applyUrl || null };
  },
};

export const PROVIDERS = { ashby, greenhouse, lever, smartrecruiters };

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
    if (!seg || seg.toLowerCase() !== wanted) return null;
    const candidate = `${u.origin}/${seg}/`;
    if (prefix === null) prefix = candidate;
    else if (prefix !== candidate) return null;
  }
  return prefix;
}
