/* =========================================================================
   Board-hatókör kapu a cím alapján — marketing/sales/HR/admin felismerés egy
   IT-fókuszú ATS-board vegyes listáján.

   Eredetileg a marketing_scraper saját, önálló ATS-crawlerének kapuja volt
   (2026-08-28); az a crawler UGYANAZOKAT a boardokat aratta le, amiket ez a
   repo cron_jobs_ATSCRAWL-background.mjs-e már amúgy is lekér az IT-oldalra —
   két scraper, két lista-hívás, ugyanarra a boardra. 2026-09-02: a duplikált
   crawler törölve, ez a fájl ide hozva át (változatlan logikával) — az
   ATSCRAWL worker most a MÁR lekért, IT-szempontból nem-releváns board-sorokat
   nézi át ezzel a kapuval, és amit átenged, azt a marketing_scraper saját
   ai-ingest.mjs-ének adja tovább (ld. _marketing_handoff.mjs). Egy lista-hívás,
   két cél.

   MI A HATÓKÖR: NEM csak a marketing. A marketing_scraper board 9 kategóriát
   ismer — Marketing, Sales, Admin/Asszisztens, Irodai, Menedzser,
   Analitika/Data, Ügyfélszolgálat, HR, Projekt (`CATEGORIES`,
   marketing_scraper repo `src/MarketingJobs.jsx`). Ez a kapu ugyanazt a
   hatókört célozza. **Ha a marketing_scraper CATEGORIES változik, ezt is vidd
   utána** (a fordítottja is igaz) — a két repo külön bundle, nem tudnak
   importálni egymásból, tehát csak kézi porttal tarthatók szinkronban (ld.
   [[category-classification-audit]] ugyanerről a hibaosztályról az
   IT-kategorizáláson).

   MIÉRT NEM A CATEGORIES REGEXEI VANNAK ITT SZÓ SZERINT: azok KÉSZ soroknak
   adnak címkét, ez viszont beengedési kapu egy vegyes listán. A `manager` /
   `\bdata\b` / `project` minta címkézésre jó, beengedésre viszont az
   "Engineering Manager", a "Data Platform Engineer" és a "Project Engineer" is
   átjönne rajta — pont az, amit egy tech-cég boardjáról nem akarunk. Ezért:
     • ERŐS jel  → önmagában beenged (marketing, sales, HR, asszisztens…),
     • GYENGE jel → csak akkor enged be, ha a címben NINCS tech-jelölő
       (admin, projekt, elemző, ügyfél, iroda),
     • a puszta "manager/menedzser/vezető" NEM jel: minden cégnél minden
       területen van manager.

   FAIL-CLOSED: ha a címben nincs explicit jel, a hirdetés KIESIK. Egy téves
   beengedés a marketing_scraper listájában látszik (rossz állás a boardon),
   egy téves kizárás csak egy hirdetést hagy ki egy amúgy is alacsony hozamú
   melléktermékből — az olcsóbb hiba.

   CSAK az ats-crawl hívja. A többi MyWebsite-scraperhez hozzákötni hiba lenne:
   azok az IT-oldalra dolgoznak, ahol ez a kapu tök más kérdésre válaszol.
   ========================================================================= */

function normalize(s) {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/* ── hamis barátok: a szintvizsgálat előtti kivágás mintája
   (_seniority_core LEVEL_FALSE_FRIENDS), ugyanazzal a logikával ──────
   A Salesforce egy szoftver, nem értékesítés: a "Salesforce Developer" nem
   sales-pozíció. Kivágjuk a címből, mielőtt bármit keresnénk benne, különben
   a `sales` tő elsülne rá. Ami MARAD, az dönt: a "Developer" tech-jelölő,
   tehát kiesik; a "Salesforce Administrator" viszont bejön admin jelként —
   szándékosan, mert a CRM-adminisztráció a board hatókörében van (a `crm`
   amúgy is erős jel). */
const FALSE_FRIENDS = /salesforce/g;

/* ── ERŐS jelek: önmagukban beengednek ───────────────────────────────
   Szótöves (substring) illesztés, mert a magyar cím ragoz és összetesz
   ("Marketingasszisztens", "Ügyfélszolgálati munkatárs"). Ide CSAK olyan tő
   kerülhet, ami más szó belsejében nem fordul elő: a "marketing" ilyen (a
   "marketplace"-ben nincs benne), a "pr" nem — az a WORDS listába való. */
const STRONG_STEMS = [
  // Marketing
  "marketing", "markeging",              // gyakori elgépelés élő hirdetésekben
  "brand", "markaepit",
  "copywrit", "szovegir", "content", "tartalom",
  "social media", "kozossegi media", "kozossegimedia",
  "influencer", "advertis", "reklam", "hirdetes",
  "kampany", "campaign",
  "growth",
  "piackutat", "market research", "market analysis",
  "public relations", "sajtokapcsolat", "sajtoreferens",
  "media buy", "mediavasarl", "mediatervez",
  "email marketing", "hirlevel",
  // Sales
  "sales", "ertekesit", "uzletfejleszt", "business develop",
  "account manager", "account executive", "kereskedelmi munkatars",
  "key account", "partnerkapcsolat",
  // HR
  "human resource", "toborz", "recrui", "hr generalist", "hr business partner",
  "people partner", "people operations", "people ops", "munkaugy", "beriro",
  // Titkárság / recepció (az "asszisztens" GYENGE — ld. lentebb)
  "titkar", "recepci", "reception",
  // Ügyfélszolgálat
  "ugyfelszolgalat", "ugyfelkapcsolat", "ugyfel",
  "call center", "callcenter", "contact center",
];

/* Rövidítések: substringként bármibe beleakadnának ("seo" a "seoul"-ba, a
   "pr" gyakorlatilag mindenbe), ezért szóhatárosan illesztjük. */
const STRONG_WORDS = [
  "pr", "seo", "sea", "ppc", "crm", "cro", "ads", "adwords", "smm", "hr",
];

/* ── GYENGE jelek: csak tech-jelölő NÉLKÜLI címben engednek be ────────
   Ezek a kategóriák valódiak (Admin, Irodai, Analitika, Ügyfélszolgálat,
   Projekt), de a szavuk egy tech-cég boardján túlnyomórészt mérnöki
   pozíciót jelöl: "System Administrator", "Project Engineer", "Data Platform
   Analyst", "Customer Support Engineer". */
const WEAK_STEMS = [
  "admin",                       // adminisztrátor, administration, Admin Officer
  "projekt", "project",
  "elemz", "analiti", "analyst",
  "customer", "ugyintez",
  "communication", "kommunikaci", // Communications Engineer is létezik
  /* Az "assistant" azért gyenge, mert a tech-cégek terméknevei tele vannak
     vele: az "Engineering Lead - Wise AI Assistant Platform" nem asszisztensi
     állás. Emberi asszisztensi címben (Marketing Assistant, Executive
     Assistant, Marketingasszisztens) nincs tech-jelölő, tehát átmegy. */
  "asszisztens", "assistant",
];

/* Szándékosan NEM jel a puszta "koordinator" / "coordinator": a boardnak
   nincs ilyen kategóriája, a szó viszont minden területen előfordul
   (logisztika, üzemeltetés, éttermi ops). A releváns alakjait az erős jel
   viszi be úgyis ("Marketing Coordinator", "HR Coordinator"). */

const WEAK_WORDS = [
  "office", "irodai", "backoffice",  // "officer" NE illeszkedjen: szóhatárosan
];

/* ── tech-jelölők: a GYENGE jelet vétózzák ───────────────────────────
   Nem a hirdetés minőségéről mondanak semmit — csak azt, hogy a gyenge jel
   ebben a címben nem a mi kategóriánkat jelenti. Erős jelre NEM hatnak: a
   "Technical Marketing Manager" marketinges, a "Sales Engineer" sales. */
const TECH_MARKERS = [
  "engineer", "engineering", "developer", "fejleszt", "software", "szoftver",
  "backend", "frontend", "fullstack", "full stack", "devops", "sre",
  "programoz", "informatik", "rendszergazda", "sysadmin",
  "system administrator", "database administrator", "network",
  "infrastructure", "platform", "architect", "cloud", "kubernetes",
  "security", "biztonsagi", "penetration",
  "qa ", "tester", "tesztel", "automation",
  "machine learning", "data scientist", "data engineer", "adatmernok",
  "java", "python", "javascript", "typescript", "golang", "react", "android",
  "ios ", "mobile", "embedded", "firmware", "hardware", "technical",
  "product designer", "ux", "ui ",
];

// A szóhatáros listák szándékosan csak betűt/számot tartalmaznak, így sosem
// kell regexet escape-elni; ami mégis becsúszik, azt kidobjuk.
const NON_ALNUM = /[^a-z0-9]/g;
const _reCache = new Map();
function wordRegex(word) {
  let re = _reCache.get(word);
  if (!re) {
    const safe = word.replace(NON_ALNUM, "");
    re = new RegExp(`(^|[^a-z0-9])${safe}([^a-z0-9]|$)`, "i");
    _reCache.set(word, re);
  }
  return re;
}

function firstMatch(text, stems, words) {
  const stem = stems.find((s) => text.includes(s));
  if (stem) return stem;
  return words.find((w) => wordRegex(w).test(text)) || null;
}

/** Van-e a címben tech-jelölő? (Csak a gyenge jelek vétójához.) */
export function hasTechMarker(title) {
  const t = normalize(title);
  return TECH_MARKERS.some((m) => t.includes(m));
}

/**
 * Az első jel, ami miatt beengedjük a hirdetést (naplózáshoz).
 * @returns {string|null} a találat, vagy null ha a cím kívül esik a hatókörön
 */
export function scopeSignal(title) {
  const t = normalize(title).replace(FALSE_FRIENDS, " ");
  if (!t) return null;

  const strong = firstMatch(t, STRONG_STEMS, STRONG_WORDS);
  if (strong) return strong;

  const weak = firstMatch(t, WEAK_STEMS, WEAK_WORDS);
  if (!weak) return null;
  if (TECH_MARKERS.some((m) => t.includes(m))) return null;
  return weak;
}

/** A marketing_scraper board hatókörébe esik-e a cím? (Nincs jel = NEM.) */
export function isInScopeTitle(title) {
  return scopeSignal(title) !== null;
}
