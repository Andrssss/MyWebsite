/*
 * Helyszín-kapu az ATS-crawl forráshoz — SZIGORÚBB, mint a rendszer többi része.
 *
 * User-döntés 2026-08-26 (WEB_CRAWLER_PLAN.md §6.3): ennél az EGY forrásnál
 *   • üres/hiányzó helyszín  → ELDOBJUK   (a globális szabály megtartaná!)
 *   • explicit HU-jelzés kell (budapest / magyarorszag / hungary / …)
 *   • ha van MELLETTE nem-budapesti város vagy külföldi ország → ELDOBJUK
 *
 * Miért nem a megosztott isNonBudapestLocation (_ai_ingest_core.mjs)?  Mert
 * abban a "nincs megadva helyszín = megtartjuk" a 2026-07-24-i explicit
 * user-döntés az ai-scraped útra, és azt tilos mellékhatásként elrontani.  Itt
 * fordított az alapértelmezés, mert egy nemzetközi ATS-board alapból KÜLFÖLDI:
 * a `uipath` boardon 116 állás van és 0 magyar, a `datadog`-on 451 és 0 —
 * fail-open mellett ezek mind besétálnának, amint a location mező hiányos.
 *
 * FAIL-CLOSED: a bizonytalan eset (nincs helyszín-információ) = eldobás.
 * Ez a lényegi eltérés a rendszer többi szűrőjétől, ahol a bizonytalan eset
 * megtartás. Szándékos, ld. a doc §4 "Helyszín-kapu" szakaszát.
 */

function normalize(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// Explicit magyar jelzés. Az ATS-boardok angolul írnak, de a magyar tenantok
// néha magyarul — mindkettő kell.
const HU_HINTS = [
  "budapest", "magyarorszag", "hungary", "hungria", "ungarn", "hongrie", "hu-",
];

/* ── nem-budapesti magyar városok ────────────────────────────────────
   Mag: _profession_core.mjs DUPLICATE_CITY_SLUGS (13 város) MÍNUSZ budapest.
   Az a lista URL-slug-dedupra készült, nem helyszín-szűrésre, ezért itt
   kiegészítve a többi megyeszékhellyel + a gyakori ipari/IT-városokkal. */
const HU_CITIES_NON_BP = [
  "debrecen", "szeged", "pecs", "gyor", "miskolc", "kecskemet",
  "szekesfehervar", "nyiregyhaza", "szombathely", "veszprem", "eger", "sopron",
  "kaposvar", "bekescsaba", "zalaegerszeg", "tatabanya", "salgotarjan",
  "szolnok", "szekszard", "dunaujvaros", "hodmezovasarhely", "esztergom",
  "godollo", "kecskemet", "paks", "mosonmagyarovar", "nagykanizsa",
  "ozd", "vac", "cegled", "baja", "szentendre", "budaors", "erd",
];

/* ── külföldi városok + országok ─────────────────────────────────────
   Egy ATS-boardon a multi-location hirdetés ("Budapest, Hungary; Berlin,
   Germany") a tipikus eset, amit a user ki akart zárni. Ország is kell, nem
   csak város: a "Hungary; Germany" alakban egyetlen városnév sincs. */
const FOREIGN_PLACES = [
  // városok
  "berlin", "munich", "munchen", "hamburg", "frankfurt", "cologne", "koln",
  "vienna", "wien", "graz", "salzburg", "linz",
  "prague", "praha", "brno", "ostrava",
  "bratislava", "kosice", "warsaw", "warszawa", "krakow", "cracow", "wroclaw",
  "gdansk", "poznan", "lodz", "katowice",
  "bucharest", "bucuresti", "cluj", "timisoara", "iasi", "brasov",
  "belgrade", "beograd", "novi sad", "zagreb", "ljubljana", "sarajevo",
  "sofia", "plovdiv", "athens", "thessaloniki", "istanbul", "ankara",
  "london", "manchester", "birmingham", "edinburgh", "glasgow", "bristol",
  "dublin", "cork", "paris", "lyon", "toulouse", "marseille", "bordeaux",
  "amsterdam", "rotterdam", "utrecht", "eindhoven", "brussels", "bruxelles",
  "antwerp", "luxembourg", "zurich", "geneva", "basel", "bern", "lausanne",
  "madrid", "barcelona", "valencia", "seville", "malaga", "bilbao",
  "lisbon", "lisboa", "porto", "milan", "milano", "rome", "roma", "turin",
  "torino", "bologna", "naples", "florence",
  "stockholm", "gothenburg", "malmo", "copenhagen", "kobenhavn", "aarhus",
  "oslo", "bergen", "helsinki", "espoo", "tampere",
  "tallinn", "tartu", "riga", "vilnius", "kaunas",
  "kyiv", "kiev", "lviv", "moscow", "minsk",
  "new york", "brooklyn", "san francisco", "san jose", "palo alto",
  "mountain view", "los angeles", "san diego", "seattle", "portland",
  "austin", "dallas", "houston", "denver", "boulder", "chicago", "detroit",
  "boston", "cambridge, ma", "atlanta", "miami", "orlando", "philadelphia",
  "washington", "raleigh", "charlotte", "phoenix", "las vegas", "salt lake",
  "toronto", "vancouver", "montreal", "ottawa", "calgary",
  "mexico city", "guadalajara", "sao paulo", "rio de janeiro", "buenos aires",
  "bogota", "santiago", "lima", "montevideo",
  "tel aviv", "jerusalem", "haifa", "dubai", "abu dhabi", "doha", "riyadh",
  "cairo", "nairobi", "lagos", "johannesburg", "cape town",
  "bangalore", "bengaluru", "mumbai", "delhi", "gurgaon", "gurugram",
  "hyderabad", "chennai", "pune", "noida", "kolkata",
  "singapore", "hong kong", "shanghai", "beijing", "shenzhen", "tokyo",
  "osaka", "seoul", "taipei", "manila", "jakarta", "bangkok", "kuala lumpur",
  "ho chi minh", "hanoi",
  "sydney", "melbourne", "brisbane", "perth", "auckland", "wellington",
  // országok / régiók
  "germany", "deutschland", "austria", "osterreich", "switzerland", "schweiz",
  "poland", "polska", "czech", "czechia", "slovakia", "slovenia", "croatia",
  "serbia", "romania", "bulgaria", "greece", "turkey", "ukraine",
  "united kingdom", "england", "scotland", "ireland", "france", "belgium",
  "netherlands", "nederland", "holland", "spain", "espana", "portugal",
  "italy", "italia", "sweden", "norway", "denmark", "finland", "iceland",
  "estonia", "latvia", "lithuania", "luxembourg", "malta", "cyprus",
  "united states", "usa", "u.s.", "canada", "mexico", "brazil", "argentina",
  "chile", "colombia", "peru", "india", "china", "japan", "korea",
  "singapore", "australia", "new zealand", "israel", "egypt", "nigeria",
  "kenya", "south africa", "morocco", "tunisia", "uae", "qatar",
  "philippines", "vietnam", "indonesia", "malaysia", "thailand", "pakistan",
];

// Szóhatáros illesztés — ugyanaz a minta, amit a _seniority_policy és minden
// scraper _blacklistRegex-e használ. Enélkül a "vac" (Vác) beleakadna a
// "vacancy" szóba, az "erd" az "Aberdeen"-be.
const _reCache = new Map();
function wordRegex(word) {
  let re = _reCache.get(word);
  if (!re) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    re = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i");
    _reCache.set(word, re);
  }
  return re;
}

const BLOCKED_PLACES = [...HU_CITIES_NON_BP, ...FOREIGN_PLACES];

/** Van-e a szövegben explicit magyar helyszín-jelzés? */
export function hasHungarianHint(location) {
  const n = normalize(location);
  if (!n) return false;
  return HU_HINTS.some((h) => n.includes(h));
}

/** Az ELSŐ nem-budapesti hely, ami kizárja a hirdetést (naplózáshoz). */
export function blockingPlace(location) {
  const n = normalize(location);
  if (!n) return null;
  for (const place of BLOCKED_PLACES) {
    if (wordRegex(place).test(n)) return place;
  }
  return null;
}

/**
 * Eldobjuk-e a hirdetést a helyszíne alapján?  (Az `ingestJobs` rejectLocation
 * kapujának alakja: true = SKIP.)
 *
 * @param {string} location  a board-ról olvasott teljes helyszín-szöveg —
 *   a hívónak MINDEN helyszínt bele kell fűznie (Ashby secondaryLocations,
 *   Lever categories.allLocations, Greenhouse offices), különben egy
 *   "Budapest" elsődleges helyszín elrejti a mellette lévő berlini másodlagosat.
 */
export function rejectAtsLocation(location) {
  if (!hasHungarianHint(location)) return true;   // üres is ide esik
  return blockingPlace(location) !== null;
}
