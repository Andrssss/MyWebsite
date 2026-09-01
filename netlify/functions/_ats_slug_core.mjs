/*
 * ATS slug-felderítés magja (WEB_CRAWLER_PLAN.md F2).
 *
 * Két dolgot csinál, és mindkettőt kell:
 *   1. cégnév  → slug-jelöltek   (candidateSlugs)
 *   2. ATS-URL → provider + slug (parseAtsUrl)
 *
 * Az (1) a saját adatunkból dolgozik: a `job_posts.company` több ezer olyan
 * céget tartalmaz, amiről BIZONYÍTOTTAN tudjuk, hogy Magyarországon hirdet —
 * ez sokkal jobb lead-forrás, mint egy random webcrawl. A (2) a kereső-alapú
 * ág bemenete: ha egy találat url-je `jobs.ashbyhq.com/<slug>/...`, akkor a
 * slug ott van az url-ben, nem kell kitalálni.
 *
 * Miért csak a tiszta-404-es providereken próbálkozunk (ashby/greenhouse/lever)?
 * Mert a SmartRecruiters a nemlétező cégre is 200-at ad üres listával (élőben
 * igazolt 2026-08-26) — ott a "nincs ilyen board" nem megkülönböztethető a
 * "nincs nyitott állás"-tól, tehát a tippelt slug SOSEM cáfolható, és a tábla
 * megtelne örökre bizonytalan sorokkal. SR-tenantot csak explicit url-ből
 * (parseAtsUrl) vagy kézzel veszünk fel.
 */

/* ── cégnév → slug-jelöltek ──────────────────────────────────────── */

// Cégforma- és ország-utótagok. Ezek a cégnévben vannak, de a slugban SOSEM
// (a "SEON Technologies Kft." boardja `seon`, nem `seontechnologieskft`).
const LEGAL_SUFFIXES = new Set([
  "kft", "kft.", "bt", "bt.", "zrt", "zrt.", "nyrt", "nyrt.", "rt", "rt.",
  "kkt", "kv", "ev", "eva", "szovetkezet", "alapitvany", "egyesulet",
  "ltd", "limited", "llc", "inc", "corp", "corporation", "co", "company",
  "gmbh", "ag", "se", "sa", "srl", "spa", "bv", "nv", "oy", "ab", "as",
  "plc", "pte", "sarl", "sp", "zoo", "doo", "dd",
  "hungary", "hungaria", "magyarorszag", "magyar", "hu", "cee", "emea",
]);

// Túl általános szavak: önmagukban SOHA nem lehetnek jelöltek, mert vagy
// idegen cég boardját találnák el, vagy garantált 404-ek. (A "tech" slug pl.
// nem a mi cégünk boardja lenne, hanem valaki másé.)
const GENERIC_TOKENS = new Set([
  "it", "tech", "technology", "technologies", "group", "holding", "solutions",
  "solution", "consulting", "consultants", "services", "service", "systems",
  "system", "digital", "software", "labs", "lab", "media", "partners",
  "partner", "international", "global", "europe", "european", "center",
  "centre", "studio", "studios", "agency", "team", "works", "network",
  "networks", "data", "cloud", "online", "web", "app", "apps", "mobile",
  "energy", "bank", "finance", "financial", "capital", "invest", "trade",
  "trading", "logistics", "industries", "industrial", "engineering",
  "development", "developments", "research", "innovation", "innovations",
  "office", "offices", "hungary", "budapest",
]);

export function normalizeCompanyName(name) {
  return String(name ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Egy cégnévből a reálisan lehetséges board-slugok.
 *
 * Szándékosan KEVÉS variáns cégenként (max 4): minden jelölt 3 HTTP-kérés
 * (3 provider), és a cél nem az, hogy minden lehetőséget lefedjünk, hanem hogy
 * a tipikus alakokat olcsón eltaláljuk. A mérés szerint a cégek a rövid,
 * márkanév-alapú slugot használják (`seon`, `shapr3d`, `craftdocs`), nem a
 * teljes hivatalos nevet.
 *
 * @returns {string[]} egyedi, ésszerű hosszúságú slug-jelöltek
 */
export function candidateSlugs(companyName) {
  const normalized = normalizeCompanyName(companyName);
  if (!normalized) return [];

  const tokens = normalized
    .split(" ")
    .filter((t) => t && !LEGAL_SUFFIXES.has(t));
  if (tokens.length === 0) return [];
  // Csupa általános szóból álló név ("IT Solutions", "Digital Services") nem ad
  // jelöltet: az összevont alak ("itsolutions") sem a cég boardja lenne. A
  // token-szintű vizsgálat kell, a kész slug ellenőrzése ezt nem fogja meg.
  if (tokens.every((t) => GENERIC_TOKENS.has(t))) return [];

  const out = [];
  const push = (s) => {
    if (!s) return;
    // 3 karakter alatt bármire ráillene; 40 fölött biztosan nem slug.
    if (s.length < 3 || s.length > 40) return;
    if (GENERIC_TOKENS.has(s)) return;
    if (!out.includes(s)) out.push(s);
  };

  // 1. az első token önmagában — ez a leggyakoribb valódi alak, kivéve ha
  //    általános szó (akkor a következő variánsok viszik tovább)
  if (!GENERIC_TOKENS.has(tokens[0])) push(tokens[0]);
  // 2. első kettő összevonva ("craft docs" → "craftdocs")
  if (tokens.length >= 2) push(tokens.slice(0, 2).join(""));
  // 3. első kettő kötőjellel
  if (tokens.length >= 2) push(tokens.slice(0, 2).join("-"));
  // 4. az egész név összevonva (rövid neveknél ez ugyanaz, mint 2.)
  push(tokens.join(""));

  return out.slice(0, 4);
}

/* ── ATS-url → {provider, slug} ──────────────────────────────────── */

// Csak azok a hostok, amikhez van adapterünk (_ats_providers.mjs). Egy
// ismeretlen ATS url-jét NEM találgatjuk: felvenni olyan tenantot, amit
// learatni nem tudunk, csak szemetelne a táblában.
const URL_PATTERNS = [
  { provider: "ashby", re: /^https?:\/\/jobs\.ashbyhq\.com\/([^/?#]+)/i },
  // A greenhouse EU-boardjai külön hoston élnek (job-boards.eu.greenhouse.io) —
  // pontosan ezt adja vissza a listázó API absolute_url-je EU-s cégeknél, tehát
  // enélkül a SAJÁT ats-crawl sorunk url-jét sem ismernénk fel ATS-urlként (élő
  // eset: abbyy). A slug ugyanaz, és a board a nem-EU-s boards-api hoston keresztül
  // aratható — ezt az ats-crawl saját, már meglévő abbyy-sorai igazolják.
  { provider: "greenhouse", re: /^https?:\/\/(?:job-)?boards(?:-api)?\.(?:eu\.)?greenhouse\.io\/(?:embed\/job_board\?for=)?([^/?#]+)/i },
  { provider: "greenhouse", re: /^https?:\/\/job-boards\.(?:eu\.)?greenhouse\.io\/([^/?#]+)/i },
  { provider: "lever", re: /^https?:\/\/jobs\.(?:eu\.)?lever\.co\/([^/?#]+)/i },
  // Recruitee: a tenant a HOST első címkéje, nem az útvonal első szegmense
  // (blackbelt.recruitee.com/o/<hirdetés>). A cég saját domainje
  // (karrier.blackbelt.hu) SZÁNDÉKOSAN nincs itt: abból nem olvasható ki a
  // recruitee-slug, tehát learatni sem tudnánk a boardot.
  { provider: "recruitee", re: /^https?:\/\/([^./]+)\.recruitee\.com\//i },
  // Personio: szintén host-címke a tenant, és MINDKÉT platform-host ugyanazt a
  // boardot szolgálja ki (`.jobs.personio.de` és `.jobs.personio.com` — élőben
  // mérve bájtazonos), tehát a felismerésnek mindkettőt el kell fogadnia.
  { provider: "personio", re: /^https?:\/\/([^./]+)\.jobs\.personio\.(?:com|de)\//i },
  { provider: "smartrecruiters", re: /^https?:\/\/jobs\.smartrecruiters\.com\/([^/?#]+)/i },
  { provider: "smartrecruiters", re: /^https?:\/\/careers\.smartrecruiters\.com\/([^/?#]+)/i },
];

/* Workday: a tenantot HÁROM adat azonosítja (tenant + wdN + site), és
   mindhárom ott van a hirdetés url-jében — a locale-szegmens opcionális
   ("…/en-US/External/job/…" és "…/SanofiCareers/job/…" is előfordul a saját
   sorainkban). Ezért nem fér bele a fenti egy-capture-ös mintába. A slug-alak
   ugyanaz, amit a _ats_providers.mjs parseWorkdaySlug-ja vár. */
const WORKDAY_URL = /^https?:\/\/([a-z0-9][a-z0-9-]*)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Za-z]{2}\/)?([A-Za-z0-9_-]+)\/job\//i;

// A greenhouse `embed/job_board?for=X` alak query-ben hozza a slugot.
const GH_EMBED = /^https?:\/\/boards\.(?:eu\.)?greenhouse\.io\/embed\/job_board\?for=([^&#]+)/i;

/**
 * Kiszedi egy ATS-hirdetés url-jéből a providert és a cég-slugot.
 * @returns {{provider: string, slug: string}|null}
 */
export function parseAtsUrl(rawUrl) {
  const url = String(rawUrl ?? "").trim();
  if (!url) return null;

  const embed = url.match(GH_EMBED);
  if (embed) return { provider: "greenhouse", slug: decodeURIComponent(embed[1]).toLowerCase() };

  // Külön ág, mert a lenti ciklus mindent lowercase-el, a site nevét viszont
  // eredeti alakban tartjuk meg. (A cxs-API maga kis-nagybetű-tűrő — élőben
  // mérve External/external/EXTERNAL mind 200 —, de a tárolt PUBLIKUS url a
  // board saját alakja legyen, ne a mi átírásunk.)
  const wd = url.match(WORKDAY_URL);
  if (wd) return { provider: "workday", slug: `${wd[1].toLowerCase()}.${wd[2].toLowerCase()}:${wd[3]}` };

  for (const { provider, re } of URL_PATTERNS) {
    const m = url.match(re);
    if (!m) continue;
    const slug = decodeURIComponent(m[1]).toLowerCase();
    // A greenhouse api-host útvonalán a slug a /boards/<slug>/jobs alatt van,
    // az első szegmens ott "v1" — azt nem fogadjuk el slugként.
    if (!slug || slug === "v1" || slug === "embed" || slug.length > 60) continue;
    return { provider, slug };
  }
  return null;
}

/* ── próbálkozás ─────────────────────────────────────────────────── */

// Csak ezeken tippelünk: mind tiszta 404-et ad nemlétező slugra, tehát a
// negatív válasz is információ. A smartrecruiters szándékosan kimarad (lásd a
// fájl fejlécét) — oda a globális kereső hozza a tenantokat.
//
// A recruitee 2026-08-30-án került be (élő mérés: nemlétező tenant →
// 404 `{"error":"Not Found"}`). FONTOS: a jelölt-tábla ekkor már ki volt
// merítve (mind a ~2300 slug lepróbálva a másik hármon), ezért a felderítő
// PROVIDERENKÉNT könyveli, mit próbált már — különben egyetlen régi jelöltet
// sem néznénk meg az új provideren, és az egész bővítés csak a jövőbeli új
// cégnevekre hatna. Ld. cron_ats_discover-background.mjs `probed_providers`.
export const PROBEABLE_PROVIDERS = ["ashby", "greenhouse", "lever", "recruitee", "personio"];

const HOST_SLUG = /^[a-z0-9][a-z0-9-]*$/i;

const PROBE_URL = {
  ashby: (s) => `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(s)}`,
  greenhouse: (s) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(s)}/jobs`,
  lever: (s) => `https://api.lever.co/v0/postings/${encodeURIComponent(s)}?mode=json`,
  // A slug itt hostnév-részlet: a nem slug-alakú jelöltet meg sem próbáljuk.
  recruitee: (s) => (HOST_SLUG.test(s) ? `https://${s}.recruitee.com/api/offers/` : null),
  personio: (s) => (HOST_SLUG.test(s) ? `https://${s}.jobs.personio.com/xml` : null),
};

/* Providerenkénti "ez cáfolat, nem hiba" státuszok.
   A personio ISMERETLEN aldomainre 429-et ad, nem 404-et (élőben mérve
   2026-08-30: ugyanabban a másodpercben egy létező tenant 200-at adott, tehát
   nem throttling). Enélkül minden személytelen personio-jelölt "error"-ként
   ülne a táblában, és a 7 naponkénti újrapróbálás ÖRÖKRE elenné a napi
   próba-keretet. A kockázat vállalt és tudatos: egy VALÓDI rate limit
   pillanatában egy létező tenant is "miss"-re állna. */
const PROBE_MISS_STATUS = { personio: [404, 429] };

/**
 * Létezik-e ez a board? HEAD helyett GET, mert a három API közül kettő HEAD-re
 * nem a lista-státuszt adja vissza; viszont csak a státuszkód érdekel minket,
 * a törzset eldobjuk.
 *
 * @returns {Promise<"hit"|"miss"|"error">}
 */
export async function probeSlug(provider, slug, { timeoutMs = 15000 } = {}) {
  const build = PROBE_URL[provider];
  if (!build) return "error";
  const url = build(slug);
  // A provider maga mondta meg, hogy erre a slugra nem is értelmes a kérdés
  // (pl. recruitee + hostnévbe nem illő karakterek) — ez cáfolat, nem hiba.
  if (!url) return "miss";
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "JobWatcher/1.0 (+https://bakan7.netlify.app)", Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 404) return "miss";
    if ((PROBE_MISS_STATUS[provider] || []).includes(res.status)) return "miss";
    if (!res.ok) return "error"; // 429/5xx → nem cáfolat, később újrapróbálható
    return "hit";
  } catch {
    return "error";
  }
}
