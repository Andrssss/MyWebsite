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
  { provider: "greenhouse", re: /^https?:\/\/(?:job-)?boards(?:-api)?\.greenhouse\.io\/(?:embed\/job_board\?for=)?([^/?#]+)/i },
  { provider: "greenhouse", re: /^https?:\/\/job-boards\.greenhouse\.io\/([^/?#]+)/i },
  { provider: "lever", re: /^https?:\/\/jobs\.(?:eu\.)?lever\.co\/([^/?#]+)/i },
  { provider: "smartrecruiters", re: /^https?:\/\/jobs\.smartrecruiters\.com\/([^/?#]+)/i },
  { provider: "smartrecruiters", re: /^https?:\/\/careers\.smartrecruiters\.com\/([^/?#]+)/i },
];

// A greenhouse `embed/job_board?for=X` alak query-ben hozza a slugot.
const GH_EMBED = /^https?:\/\/boards\.greenhouse\.io\/embed\/job_board\?for=([^&#]+)/i;

/**
 * Kiszedi egy ATS-hirdetés url-jéből a providert és a cég-slugot.
 * @returns {{provider: string, slug: string}|null}
 */
export function parseAtsUrl(rawUrl) {
  const url = String(rawUrl ?? "").trim();
  if (!url) return null;

  const embed = url.match(GH_EMBED);
  if (embed) return { provider: "greenhouse", slug: decodeURIComponent(embed[1]).toLowerCase() };

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

// Csak ezeken tippelünk: mindhárom tiszta 404-et ad nemlétező slugra, tehát a
// negatív válasz is információ. A smartrecruiters szándékosan kimarad (lásd a
// fájl fejlécét).
export const PROBEABLE_PROVIDERS = ["ashby", "greenhouse", "lever"];

const PROBE_URL = {
  ashby: (s) => `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(s)}`,
  greenhouse: (s) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(s)}/jobs`,
  lever: (s) => `https://api.lever.co/v0/postings/${encodeURIComponent(s)}?mode=json`,
};

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
  try {
    const res = await fetch(build(slug), {
      headers: { "User-Agent": "JobWatcher/1.0 (+https://bakan7.netlify.app)", Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 404) return "miss";
    if (!res.ok) return "error"; // 429/5xx → nem cáfolat, később újrapróbálható
    return "hit";
  } catch {
    return "error";
  }
}
