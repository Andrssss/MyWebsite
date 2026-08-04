import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { FaEnvelope, FaLinkedin } from "react-icons/fa";
import { adminFetch, purgeJobListCache, ensureAdminSecret } from "./adminAuth";
import "./JobWatcher.css";

const API_BASE_URL = "/.netlify/functions";
const TIME_RANGE_24H = "24h";
const TIME_RANGE_7D = "7d";

const VISITOR_TRACK_API = "/.netlify/functions/daily-visitor";
const VISITOR_COOKIE_NAME = "jobWatcherVisitorId";
const DAILY_VISITOR_SENT_KEY = "jobWatcherVisitorSentDate";
const ONE_MINUTE_MS = 60 * 1000;

const getTodayLocalDateString = () => {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

// ISO időbélyeg -> helyi YYYY-MM-DD (a toISOString UTC-je éjfél körül egy
// nappal elcsúszna, ezért helyi mezőkből építjük).
const localDateStringFrom = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return getTodayLocalDateString();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

const readCookie = (name) => {
  const cookieName = `${name}=`;
  const parts = document.cookie.split(";");
  for (const part of parts) {
    const item = part.trim();
    if (item.startsWith(cookieName)) {
      return decodeURIComponent(item.slice(cookieName.length));
    }
  }
  return "";
};

const writeCookie = (name, value, days) => {
  const expires = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toUTCString();
  document.cookie = `${name}=${encodeURIComponent(value)}; expires=${expires}; path=/; SameSite=Lax`;
};

const createVisitorId = () => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
};

// A látogatói UUID egyszerre analitika-azonosító ÉS a little-admin kulcs
// (jobs.js a cookie-t hasonlítja a LITTLE_ADMIN* env-ekhez), ezért nem mindegy,
// mennyire tartós. "Soha nem lejáró" cookie nincs: a Chrome 104+ MINDEN cookie
// lejáratát 400 napra vágja, a Safari ITP a JS-ből írt cookie-t 7 napra, expires
// nélkül pedig session-cookie lenne (böngészőzáráskor elveszne). Ezért:
//   1) localStorage a forrás — annak nincs lejárata, túléli a cookie-vágást,
//   2) a cookie-t MINDEN híváskor újraírjuk, így az ablak folyton előre tolódik
//      (gördülő lejárat) — aktív használat mellett gyakorlatilag sosem jár le.
// A cookie-ra továbbra is szükség van: a szerver csak azt látja.
const VISITOR_ID_STORAGE = "jobWatcherVisitorId";
const VISITOR_COOKIE_DAYS = 400; // a böngésző felső korlátja; feljebb vinni nincs értelme

const getOrCreateVisitorId = () => {
  let id = readCookie(VISITOR_COOKIE_NAME);
  if (!id) {
    try {
      id = localStorage.getItem(VISITOR_ID_STORAGE) || "";
    } catch {
      id = ""; // privát mód / letiltott storage — új azonosítót generálunk
    }
  }
  if (!id) id = createVisitorId();
  try {
    localStorage.setItem(VISITOR_ID_STORAGE, id);
  } catch {
    // nem végzetes: marad a cookie a gördülő lejáratával
  }
  writeCookie(VISITOR_COOKIE_NAME, id, VISITOR_COOKIE_DAYS);
  return id;
};

const VISITOR_CLICK_API = "/.netlify/functions/visitor-click";

const CLICKED_KEYS_STORAGE = "jobWatcherClickedKeys";
const APPLIED_KEYS_STORAGE = "jobWatcherAppliedKeys";
const INTERVIEW_KEYS_STORAGE = "jobWatcherInterviewKeys";
// Purely client-side bookmark: no API call, no server state — just a local
// highlight so a visitor can pick postings out of the list on their own device.
const HIGHLIGHTED_KEYS_STORAGE = "jobWatcherHighlightedKeys";

// Shared admin applied/interview list lives in the DB (see job-applied.js).
const JOB_APPLIED_API = "/.netlify/functions/job-applied";
const ADMIN_VISITOR_IDS = new Set([
  "43e878e0-f5fd-45f3-bfd4-9473e5deec11",
  "69872482-1311-4702-a5e5-a782ca9f2669",
  "82906f93-dfbb-4684-b2b1-a948b99553e0",
  "b878ceed-55b7-47db-87ec-c4e2825246f8",
]);

// Trim a job to just the fields the applied/interview list needs to render.
const compactJob = (job) =>
  job
    ? {
        source: job.source,
        title: job.title,
        url: job.url,
        firstSeen: job.firstSeen,
        experience: job.experience,
        company: job.company,
        description: job.description,
      }
    : undefined;

// Identity of an applied/interview mark. Two postings can share a title
// (same position at another company), so key on the url — the job_posts row
// identity — whenever we have one. The title form only remains for url-less
// entries (manual adds without link).
const jobKeyFor = (job) =>
  job?.url
    ? `job:${job.source}:${job.url}`
    : `job:${job?.source}:${job?.title}`;

// A beillesztett linkből kitalálja a forrás nevet: a TLD előtti domain-tag
// (hu.talent.com -> talent, career.greehill.com -> greehill,
// profession.hu -> profession). Üres stringet ad, ha nem értelmezhető.
const sourceFromUrl = (raw) => {
  const trimmed = (raw || "").trim();
  if (!trimmed) return "";
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const parts = new URL(withScheme).hostname.toLowerCase().split(".").filter(Boolean);
    if (parts.length < 2) return "";
    // Összetett TLD-k (co.uk, com.au, ...) második tagját átugorjuk.
    const secondLevelTlds = new Set(["co", "com", "org", "net", "gov", "edu"]);
    let i = parts.length - 2;
    if (i > 0 && secondLevelTlds.has(parts[i])) i -= 1;
    return parts[i];
  } catch {
    return "";
  }
};

// Kézzel beillesztett link megtisztítása, hogy a jobKey rövid és stabil
// maradjon (a szerver 512 karakternél elvágja). LinkedIn kereső-linkből
// (?currentJobId=... + eBP/refId/trackingId zaj) a kanonikus
// /jobs/view/<id>/ lesz; más linkről csak az ismert tracking paraméterek
// esnek le. Séma nélküli linket https://-szel egészít ki, hogy kattintható
// abszolút URL legyen.
const normalizeJobUrl = (raw) => {
  const trimmed = (raw || "").trim();
  if (!trimmed) return "";
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const u = new URL(withScheme);
    const host = u.hostname.toLowerCase();
    if (host === "linkedin.com" || host.endsWith(".linkedin.com")) {
      const id =
        u.searchParams.get("currentJobId") ||
        (u.pathname.match(/\/jobs\/view\/(\d+)/) || [])[1];
      if (id) return `https://www.linkedin.com/jobs/view/${id}/`;
    }
    const trackingParams = new Set(["gclid", "fbclid", "refid", "trackingid", "ebp", "referralsearchid"]);
    for (const p of [...u.searchParams.keys()]) {
      if (/^utm_/i.test(p) || trackingParams.has(p.toLowerCase())) u.searchParams.delete(p);
    }
    return u.toString();
  } catch {
    return trimmed;
  }
};

// One-time upgrade of legacy title-keyed marks ("job:src:title") to the
// url-keyed format, using the cached job objects to learn each mark's url.
// Entries without a cached url keep their legacy key. Returns null when
// everything is already in the current format.
const migrateAppliedKeys = (applied, interview, cache) => {
  const moves = [];
  for (const [key, job] of Object.entries(cache || {})) {
    if (!job || !job.url || !job.source) continue;
    // A normalizeJobUrl előtti kézi felvitelek nyers linket cache-elhettek
    // (LinkedIn kereső-URL eBP/trackingId zajjal) — tisztítás nélkül a
    // migrált kulcs átlépheti a szerver 512-es limitjét, és a POST minden
    // betöltéskor 400-zal elhasal.
    const url = normalizeJobUrl(job.url);
    const migratedJob = url === job.url ? job : { ...job, url };
    const newKey = jobKeyFor(migratedJob);
    if (newKey === key) continue;
    if (newKey.length > 512) continue; // így is túl hosszú: marad a legacy kulcs
    moves.push({
      oldKey: key,
      newKey,
      job: migratedJob,
      applied: applied.has(key),
      interview: interview.has(key),
    });
  }
  if (moves.length === 0) return null;
  const appliedNext = new Set(applied);
  const interviewNext = new Set(interview);
  const cacheNext = { ...cache };
  for (const m of moves) {
    delete cacheNext[m.oldKey];
    cacheNext[m.newKey] = m.job;
    if (appliedNext.delete(m.oldKey)) appliedNext.add(m.newKey);
    if (interviewNext.delete(m.oldKey)) interviewNext.add(m.newKey);
  }
  return { applied: appliedNext, interview: interviewNext, cache: cacheNext, moves };
};

const loadClickedKeys = () => {
  try {
    return new Set(JSON.parse(localStorage.getItem(CLICKED_KEYS_STORAGE) || "[]"));
  } catch {
    return new Set();
  }
};

const saveClickedKey = (key) => {
  try {
    const set = loadClickedKeys();
    set.add(key);
    // max 500 bejegyzés, régieket eldobja
    const arr = [...set].slice(-500);
    localStorage.setItem(CLICKED_KEYS_STORAGE, JSON.stringify(arr));
  } catch {
    // silent
  }
};

const loadAppliedKeys = () => {
  try {
    return new Set(JSON.parse(localStorage.getItem(APPLIED_KEYS_STORAGE) || "[]"));
  } catch {
    return new Set();
  }
};

const saveAppliedKeys = (set) => {
  try {
    localStorage.setItem(APPLIED_KEYS_STORAGE, JSON.stringify([...set]));
  } catch {
    // silent
  }
};

const loadInterviewKeys = () => {
  try {
    return new Set(JSON.parse(localStorage.getItem(INTERVIEW_KEYS_STORAGE) || "[]"));
  } catch {
    return new Set();
  }
};

const saveInterviewKeys = (set) => {
  try {
    localStorage.setItem(INTERVIEW_KEYS_STORAGE, JSON.stringify([...set]));
  } catch {
    // silent
  }
};

const loadHighlightedKeys = () => {
  try {
    return new Set(JSON.parse(localStorage.getItem(HIGHLIGHTED_KEYS_STORAGE) || "[]"));
  } catch {
    return new Set();
  }
};

const saveHighlightedKeys = (set) => {
  try {
    localStorage.setItem(HIGHLIGHTED_KEYS_STORAGE, JSON.stringify([...set]));
  } catch {
    // silent
  }
};

const APPLIED_CACHE_STORAGE = "jobWatcherAppliedCache";

const BUG_REPORT_API = "/.netlify/functions/bug-report";
const BUG_REPORT_COOKIE = "jobWatcherLastBugReport";
const BUG_REPORT_COOLDOWN_MS = 5 * 60 * 1000;

const loadAppliedCache = () => {
  try {
    const raw = localStorage.getItem(APPLIED_CACHE_STORAGE);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
};

const saveAppliedCache = (cache) => {
  try {
    localStorage.setItem(APPLIED_CACHE_STORAGE, JSON.stringify(cache));
  } catch {
    // silent
  }
};

const sendDailyVisitor = async (visitorId) => {
  const res = await fetch(VISITOR_TRACK_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ visitorId }),
  });
  if (!res.ok) throw new Error("Visitor tracking request failed");
};

const hoursSince = (iso) => {
  const ms = Date.now() - new Date(iso).getTime();
  return ms / (1000 * 60 * 60);
};

/* =======================
   INTERN / JUNIOR LOGIKA
======================= */
const INTERN_KEYWORDS = ["intern", "gyakornok", "trainee", "diák", "diákmunka", "talent"];
const JUNIOR_KEYWORD = "junior";

// The "AI-scraped" button is a bucket, not a plain source: rows use the flat
// source "AI-scraped", but any legacy `AI - <slug>` rows still around during the
// migration belong to it too (mirrors jobs.js FIXED — keep the prefix in sync).
// Client-side source filtering loads all rows and matches by source, so the
// bucket must match the flat key OR the legacy prefix, not just exact equality.
const SOURCE_PREFIX_BUCKETS = { "AI-scraped": "AI - " };

function jobMatchesSourceKey(jobSource, key) {
  const prefix = SOURCE_PREFIX_BUCKETS[key];
  if (prefix) return jobSource === key || (jobSource || "").startsWith(prefix);
  return jobSource === key;
}

// Legacy `AI - <slug>` rows display as the flat "AI-scraped" label until the DB
// migration collapses them (so the badge never shows a stale per-company name).
function displaySource(jobSource) {
  return (jobSource || "").startsWith("AI - ") ? "AI-scraped" : jobSource;
}

const JUNIOR_EXCLUDED_SOURCES = [
  "minddiak",
  "muisz",
  "zyntern",
  "schonherz",

  "tudasdiak",
  "vizmuvek",
  "tudatosdiak",
  "ydiak",
  "qdiak",
  "miszisz"
];

/* =======================
   KEYWORD MEGJEGYZÉSEK
======================= */
const JOB_KEYWORD_NOTES = {
  helpdesk:
    "Nem mérnöki munka. Rabszolga munka. Engedd el. Ő kezeli az IT jelszavakat és eszközöket.",
  ServiceNOW:
    "Egy másikféle helpdesk. Jogosultságokat kezel, telepít szoftvereket.",
  "it gyakornok":
    "Általában ingyenmunkát jelent, nem igazi IT pozíció.",
  "business analyst":
    "IT és business között közvetít. Sok szervezés és kommunikáció.",
  "system he":
    "Gyakran üzemeltetés + support keverék.",
  "IT üzemeltetési":
    "Kész rendszerek működtetése, nem fejlesztés.",
  "IT üzemeltető":
    "Kész rendszerek működtetése, nem fejlesztés.",
  "Manuális tesztelő":
    "Frontend/API tesztelés, kevés technikai mélység. Elég uncsi, de nagy rá a kereslet, főleg AI miatt.",
  Wordpress:
    "Inkább marketing irány, nem klasszikus IT karrier.",
  QA: "Tesztelés + automatizálás.",
  DevOps:
    "Pipeline, cloud, infra. Nagy kereslet, jó irány.",
  L1: "Helpdesk belépőszint.",
};

const normalizeExperience = (experience) =>
  String(experience || "").trim().toLowerCase();

const splitTechnologies = (technologies) =>
  technologies
    ? String(technologies).split(",").map((t) => t.trim()).filter(Boolean)
    : [];

const hasJuniorLevelToken = (experience) => {
  const normalized = normalizeExperience(experience);
  return /\b(junior|palyakezdo|pályakezdő|entry\s*level|trainee|intern)\b/.test(normalized);
};

const hasMediorLevelToken = (experience) => {
  const normalized = normalizeExperience(experience);
  return /\b(medior|mid|middle)\b/.test(normalized);
};

const hasJuniorYearToken = (experience) => {
  const normalized = normalizeExperience(experience);
  // Csak az onallo 0 vagy 1 szamot kezeljuk junior jelzesnek.
  return /(^|\D)(0|1)(\D|$)/.test(normalized);
};

const isUnknownExperience = (experience) => {
  const normalized = normalizeExperience(experience);
  return (
    normalized === "" ||
    normalized === "-" ||
    normalized === "–" ||
    normalized === "—"
  );
};

const isJuniorExperience = (experience) => {
  if (isUnknownExperience(experience)) return true;
  if (hasMediorLevelToken(experience)) return false;
  return hasJuniorLevelToken(experience) || hasJuniorYearToken(experience);
};

const isMediorExperience = (experience) => {
  if (isUnknownExperience(experience)) return true;
  if (hasMediorLevelToken(experience)) return true;
  if (hasJuniorLevelToken(experience)) return false;
  return !hasJuniorYearToken(experience);
};

// Senior JELÖLÉS + szűrés: alapból elrejtjük, "Csak senior" módban KIZÁRÓLAG
// ezeket mutatjuk (ld. preTechJobs). Badge-elés is ebből. Két jel:
//   1) explicit senior/lead szint-címke (pl. NIX taxonómia "senior", MFB/
//      Raiffeisen "Szenior" szint) — egyértelmű, nem évszám;
//   2) évszám: a leírásból kinyert "5-10 years"/"7+ years"/"10 év" — a LEGKISEBB
//      évszámot vesszük, csak ha az is >= SENIOR_MIN_YEARS ("3-5 év" min 3 → NEM).
// Junior/medior/diákmunka/- szint-tokenben nincs se szám, se senior-szó → nem az.
const SENIOR_MIN_YEARS = 5;
const isSeniorExperience = (experience) => {
  const n = normalizeExperience(experience);
  if (/\b(senior|szenior|lead)\b/.test(n)) return true;
  const nums = n.match(/\d+/g);
  if (!nums) return false;
  return Math.min(...nums.map((x) => parseInt(x, 10))) >= SENIOR_MIN_YEARS;
};

const getKeywordNotesForJob = (job) => {
  if (!job.title) return [];
  const title = job.title.toLowerCase();
  return Object.entries(JOB_KEYWORD_NOTES)
    .filter(([k]) => title.includes(k.toLowerCase()))
    .map(([, v]) => v);
};

/* =======================
   KATEGÓRIÁK – dynamikusan betöltve az adatbázisból
======================= */
function kwRegex(kw) {
  const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i");
}

// Kategória-prioritás (erős → gyenge) — CSAK VÉGSŐ TIE-BREAK: a fenti egyedi
// szabályok után, ha még mindig több kategória maradt, ez választ közülük egyet.
// A szabályokat NEM írja felül, csak a maradék többértelműséget oldja fel, hogy
// egy állás pontosan egy kategóriába kerüljön. Új kategóriát ide is érdemes
// felvenni; a listán kívüli a leggyengébb prioritást kapja.
const CATEGORY_PRIORITY = [
  "C++", "DevOps", "Security", "Data / AI", "Elemző / Analyst",
  "QA / Tesztelő", "Mobil", "Menedzser / PM", "Webfejlesztés",
  "Hardware", "Mérnöki / Gyártás", "Hálózat / Infra", "Fejlesztő",
];
const categoryRank = (c) => {
  const i = CATEGORY_PRIORITY.indexOf(c);
  return i === -1 ? CATEGORY_PRIORITY.length : i;
};
const collapseByPriority = (cats) => {
  if (cats.length <= 1) return cats;
  return [[...cats].sort((a, b) => categoryRank(a) - categoryRank(b))[0]];
};

const getCategoriesForJob = (job, jobCategories) => {
  if (!job.title || !jobCategories.length) return [];
  const title = job.title.toLowerCase();
  const matches = jobCategories
    .filter(([, keywords]) => keywords.some((kw) => kwRegex(kw.toLowerCase()).test(title)))
    .map(([cat]) => cat);
  // Ha a title tartalmaz "analyst" vagy "elemző" → mindig Elemző / Analyst (keywords-től függetlenül)
  if (title.includes("analyst") || title.includes("elemző")) {
    return ["Elemző / Analyst"];
  }
  // Ha a title-ben különálló szóként szerepel "AI" → mindig Data / AI (keywords-től függetlenül)
  if (/(^|[^a-z0-9])ai([^a-z0-9]|$)/i.test(job.title)) {
    return ["Data / AI"];
  }
  // Ha több kategória matchelt, az egyik Elemző / Analyst, és a title tartalmaz "analyst"/"elemző" → csak Elemző / Analyst
  if (matches.length > 1 && matches.includes("Elemző / Analyst") && (title.includes("analyst") || title.includes("elemző"))) {
    return ["Elemző / Analyst"];
  }
  // Ha több kategória matchelt és az egyik DevOps → csak DevOps
  if (matches.length > 1 && matches.includes("DevOps")) {
    return ["DevOps"];
  }
  // Ha több kategória matchelt és az egyik C++ → csak C++
  if (matches.length > 1 && matches.includes("C++")) {
    return ["C++"];
  }
  // Fejlesztő a leggyengébb prioritás: ha bármi más is matchelt, az nyerjen (így Hálózat/Infra és Mérnöki/Gyártás is erősebb nála)
  const withoutFallback = matches.filter((c) => c !== "Fejlesztő");
  const effective = withoutFallback.length > 0 ? withoutFallback : matches;
  // Hálózat / Infra alacsony prioritású (de Fejlesztőnél erősebb): ha más nem-Fejlesztő is matchelt, az nyerjen
  let result;
  if (effective.length > 1 && effective.includes("Hálózat / Infra")) {
    result = effective.filter((c) => c !== "Hálózat / Infra");
  } else if (effective.length > 1 && effective.includes("Mérnöki / Gyártás")) {
    // Mérnöki / Gyártás alacsony prioritású (de Fejlesztőnél erősebb): ha más nem-Fejlesztő is matchelt, az nyerjen
    result = effective.filter((c) => c !== "Mérnöki / Gyártás");
  } else {
    result = effective;
  }
  // VÉGSŐ tie-break: ha a fenti szabályok után IS több kategória maradt, a prioritás dönt → egy kategória.
  return collapseByPriority(result);
};

// A teljes Források/Kategóriák/Technológiák blokk FÖLÖTT mindig látható,
// egyetlen közös csík az összes aktív (selected/excluded) szűrőből — akkor
// is, ha az adott panel épp be van csukva, hogy ne kelljen mindegyiket
// külön kinyitni annak ellenőrzéséhez, mi van épp beállítva. Kattintásra az
// adott szűrő törlődik (saját onClear-t hordoz elemenként, mert a forrás/
// kategória/tech listák külön state-tömbökben élnek).
function ActiveFilterSummary({ items }) {
  if (items.length === 0) return null;
  return (
    <div className="job-active-summary">
      {items.map(({ key, label, state, onClear }) => (
        <button
          key={key}
          type="button"
          className={`job-active-chip ${state === "selected" ? "job-active-chip--selected" : "job-active-chip--excluded"}`}
          onClick={onClear}
          title="Kattints az eltávolításhoz"
        >
          {label}
          <span className="job-active-chip-remove" aria-hidden="true">×</span>
        </button>
      ))}
    </div>
  );
}

const JobWatcher = () => {
  const navigate = useNavigate();
  const debugMode = new URLSearchParams(window.location.search).has("debug");
  const [sources, setSources] = useState([]);
  const [jobs, setJobs] = useState([]);
  // Admin-only controls are gated on a SERVER-CONFIRMED signal, not on the local
  // cookie: jobs.js sends the `hidden` column to little-admin and to nobody else,
  // so its mere presence proves the server validated the key. Faking the cookie
  // client-side yields a response without `hidden` → the controls stay hidden.
  const isLittleAdmin = useMemo(
    () => jobs.some((j) => typeof j.hidden === "boolean"),
    [jobs]
  );
  const [loading, setLoading] = useState(true);
  const [loadingSources, setLoadingSources] = useState(true);
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [savedSearches, setSavedSearches] = useState(() => {
    const saved = localStorage.getItem("jobWatcherSavedSearches");
    return saved ? JSON.parse(saved) : [];
  });
  const [activeSavedSearches, setActiveSavedSearches] = useState(() => {
    const saved = localStorage.getItem("jobWatcherActiveSavedSearches");
    return saved ? new Set(JSON.parse(saved)) : new Set();
  });
  const [jobCategories, setJobCategories] = useState([]);

  /* =======================
     FORRÁS SZŰRÉS (3 állapot)
  ======================= */
  const [sourceStates, setSourceStates] = useState(() => {
    const saved = localStorage.getItem("jobWatcherSourceStates");
    return saved ? JSON.parse(saved) : {};
  });

  /* =======================
     INTERN / JUNIOR / NEW
  ======================= */
  const [internMode, setInternMode] = useState(
    () => localStorage.getItem("jobWatcherInternMode") === "true"
  );

  const [juniorMode, setJuniorMode] = useState(
    () => localStorage.getItem("jobWatcherJuniorMode") === "true"
  );

  const [mediorMode, setMediorMode] = useState(
    () => localStorage.getItem("jobWatcherMediorMode") === "true"
  );

  const [seniorMode, setSeniorMode] = useState(
    () => localStorage.getItem("jobWatcherSeniorMode") === "true"
  );

  const [time24h, setTime24h] = useState(() => {
    const saved = localStorage.getItem("jobWatcherTime24h");
    return saved === null ? false : saved === "true";
  });
  const [time7d, setTime7d] = useState(() => {
    const saved = localStorage.getItem("jobWatcherTime7d");
    return saved === null ? false : saved === "true";
  });
  const [timeToday, setTimeToday] = useState(() => {
    const saved = localStorage.getItem("jobWatcherTimeToday");
    return saved === null ? true : saved === "true";
  });

  const [categoryStates, setCategoryStates] = useState(() => {
    const saved = localStorage.getItem("jobWatcherCategoryStates");
    return saved ? JSON.parse(saved) : {};
  });

  // Technológia-szűrő állapotok — a mentett state AKKOR IS megmarad, ha az
  // adott tech épp eltűnt a listából (0 találat): olyankor se chip, se szűrés,
  // de amint újra lesz ilyen munka, a cache-elt állapot magától érvényesül.
  const [techStates, setTechStates] = useState(() => {
    const saved = localStorage.getItem("jobWatcherTechStates");
    return saved ? JSON.parse(saved) : {};
  });

  // Források/Kategóriák/Technológiák a Szint/Frissesség sorokkal azonos
  // .job-filter-group választó mögött élnek; mindegyik saját magát nyitja/
  // csukja (nincs közös overlay/panel-gate a három fölött).
  const [sourcesSectionOpen, setSourcesSectionOpen] = useState(false);
  const [categoriesSectionOpen, setCategoriesSectionOpen] = useState(false);
  const [techSectionOpen, setTechSectionOpen] = useState(false);
  const [techSearch, setTechSearch] = useState("");
  const [allTechLabels, setAllTechLabels] = useState([]);

  const [clickedKeys, setClickedKeys] = useState(() => loadClickedKeys());
  const [appliedKeys, setAppliedKeys] = useState(() => loadAppliedKeys());
  const [interviewKeys, setInterviewKeys] = useState(() => loadInterviewKeys());
  const [highlightedKeys, setHighlightedKeys] = useState(() => loadHighlightedKeys());
  const [appliedCache, setAppliedCache] = useState(() => loadAppliedCache());
  const [showAppliedOnly, setShowAppliedOnly] = useState(false);

  const [manualAppliedTitle, setManualAppliedTitle] = useState("");
  const [manualAppliedSource, setManualAppliedSource] = useState("");
  const [manualAppliedUrl, setManualAppliedUrl] = useState("");
  // A linkből automatikusan kitöltött forrás értéke — amíg a mező ezzel
  // egyezik (vagy üres), a link változása frissítheti; kézi átírást nem bánt.
  const autoAppliedSourceRef = useRef("");
  const [manualAppliedDate, setManualAppliedDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [manualAppliedCompany, setManualAppliedCompany] = useState("");
  const [manualAppliedStatus, setManualAppliedStatus] = useState("");
  const [manualAddOpen, setManualAddOpen] = useState(false);
  // A szerkesztés alatt álló (cache-ből élő) jelentkezés TÁROLT kulcsa;
  // null = a kézi űrlap új felvitelt csinál.
  const [editingAppliedKey, setEditingAppliedKey] = useState(null);
  const manualCardRef = useRef(null);
  const myVisitorId = useMemo(() => getOrCreateVisitorId(), []);
  const isAdmin = useMemo(() => ADMIN_VISITOR_IDS.has(myVisitorId), [myVisitorId]);

  // One-time local migration of legacy title-keyed marks to url keys
  // (matters for non-admins, whose marks live only in localStorage).
  useEffect(() => {
    const migrated = migrateAppliedKeys(loadAppliedKeys(), loadInterviewKeys(), loadAppliedCache());
    if (!migrated) return;
    setAppliedKeys(migrated.applied);
    setInterviewKeys(migrated.interview);
    setAppliedCache(migrated.cache);
    saveAppliedKeys(migrated.applied);
    saveInterviewKeys(migrated.interview);
    saveAppliedCache(migrated.cache);
  }, []);

  // Admins share a single applied/interview list stored in the DB.
  // Load it on mount and make the DB the source of truth for them.
  useEffect(() => {
    if (!isAdmin && !isLittleAdmin) return;
    let cancelled = false;
    (async () => {
      try {
        // Ask for the password up front and verify it server-side, so admin
        // status is settled before anything unlocks — not discovered later.
        if (!(await ensureAdminSecret())) return;
        if (cancelled) return;
        const res = await adminFetch(JOB_APPLIED_API);
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled || !data) return;
        let applied = new Set(data.applied || []);
        let interview = new Set(data.interview || []);
        let cache = data.appliedCache || {};
        const migrated = migrateAppliedKeys(applied, interview, cache);
        if (migrated) {
          ({ applied, interview, cache } = migrated);
        }
        setAppliedKeys(applied);
        setInterviewKeys(interview);
        setAppliedCache(cache);
        saveAppliedKeys(applied);
        saveInterviewKeys(interview);
        saveAppliedCache(cache);
        if (migrated) {
          // Rename the rows in the shared DB too: insert the url-keyed row
          // first and delete the legacy one only once that succeeded, so a
          // failure just leaves the old row for the next load to retry.
          for (const m of migrated.moves) {
            try {
              const resNew = await adminFetch(JOB_APPLIED_API, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  adminId: myVisitorId,
                  jobKey: m.newKey,
                  applied: m.applied,
                  interview: m.interview,
                  job: m.job,
                }),
              });
              if (resNew.ok) {
                await adminFetch(JOB_APPLIED_API, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    adminId: myVisitorId,
                    jobKey: m.oldKey,
                    applied: false,
                    interview: false,
                  }),
                });
              }
            } catch {
              // legacy row stays; retried on the next load
            }
          }
        }
      } catch {
        // keep whatever is in localStorage
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isAdmin, isLittleAdmin, myVisitorId]);

  // Persist an applied/interview change to the shared DB (admins only).
  // Resolves to true when the DB write succeeded (non-admin: false, no write).
  const persistAdminApplied = (jobKey, applied, interview, job) => {
    if (!isAdmin && !isLittleAdmin) return Promise.resolve(false);
    return adminFetch(JOB_APPLIED_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        adminId: myVisitorId,
        jobKey,
        applied,
        interview,
        job: compactJob(job),
      }),
    })
      .then((res) => res.ok)
      .catch(() => false);
  };

  const [bugOpen, setBugOpen] = useState(false);
  const [bugMessage, setBugMessage] = useState("");
  const [bugStatus, setBugStatus] = useState("");
  const [bugSending, setBugSending] = useState(false);

  const isBugCooldown = () => {
    const val = readCookie(BUG_REPORT_COOKIE);
    if (!val) return false;
    return Date.now() - Number(val) < BUG_REPORT_COOLDOWN_MS;
  };

  const handleBugSubmit = async () => {
    const msg = bugMessage.trim();
    if (!msg) {
      setBugStatus("Írj valamit a küldés előtt.");
      return;
    }
    if (isBugCooldown()) {
      setBugStatus("Már küldtél hibajelentést nemrég. Várj egy kicsit.");
      return;
    }
    setBugSending(true);
    setBugStatus("");
    try {
      const res = await fetch(BUG_REPORT_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: msg, visitorId: myVisitorId }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        const serverError = typeof payload?.error === "string" ? payload.error : "";
        throw new Error(serverError || `HTTP ${res.status}`);
      }
      writeCookie(BUG_REPORT_COOKIE, String(Date.now()), 1);
      setBugMessage("");
      setBugStatus("✔ Köszönjük a visszajelzést!");
    } catch (err) {
      const reason = err instanceof Error && err.message ? ` (${err.message})` : "";
      setBugStatus(`✗ Hiba a küldés során. Próbáld újra.${reason}`);
    } finally {
      setBugSending(false);
    }
  };

  const toggleApplied = (key, job) => {
    setAppliedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
        setAppliedCache((c) => {
          const { [key]: _, ...rest } = c;
          saveAppliedCache(rest);
          return rest;
        });
        // Unapplying also clears the interview flag (interview ⊆ applied).
        setInterviewKeys((iv) => {
          if (!iv.has(key)) return iv;
          const n = new Set(iv);
          n.delete(key);
          saveInterviewKeys(n);
          return n;
        });
        persistAdminApplied(key, false, false, job);
      } else {
        next.add(key);
        if (job) {
          setAppliedCache((c) => {
            const updated = { ...c, [key]: job };
            saveAppliedCache(updated);
            return updated;
          });
        }
        persistAdminApplied(key, true, false, job);
      }
      saveAppliedKeys(next);
      return next;
    });
  };

  const toggleInterview = (key, job) => {
    setInterviewKeys((prev) => {
      const next = new Set(prev);
      const nowInterview = !next.has(key);
      if (nowInterview) next.add(key);
      else next.delete(key);
      saveInterviewKeys(next);
      // Interview is only tickable on applied jobs, so applied stays true.
      persistAdminApplied(key, true, nowInterview, job);
      return next;
    });
  };

  // Purely local bookmark, no API call — just so a visitor can pick a posting
  // out of the list on their own device. Persisted the same way as
  // applied/interview keys, but independent of them.
  const toggleHighlight = (key) => {
    setHighlightedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      saveHighlightedKeys(next);
      return next;
    });
  };

  // Hide/unhide a posting independently of "jelentkeztem". Optimistic: the row
  // flips locally straight away and rolls back if the server refuses.
  const toggleHidden = async (job) => {
    if (!job.url) return;
    const next = !job.hidden;
    const applyLocal = (value) =>
      setJobs((prev) =>
        prev.map((j) =>
          j.url === job.url && j.source === job.source ? { ...j, hidden: value } : j
        )
      );
    applyLocal(next);
    try {
      const res = await adminFetch(`${API_BASE_URL}/job-hidden`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: job.url, source: job.source, hidden: next }),
      });
      if (res.ok) {
        // The 5-min job-list cache still holds the pre-toggle value; drop it so
        // a refresh doesn't resurrect the old hidden state.
        purgeJobListCache();
      } else {
        applyLocal(job.hidden);
        const data = await res.json().catch(() => ({}));
        // alert(), not setStatus(): `status` is never rendered anywhere, so the
        // admin would get no sign that the toggle silently rolled back.
        window.alert(
          res.status === 401
            ? "Hibás vagy hiányzó admin jelszó — a rejtés nem mentődött el."
            : data.error || "Nem sikerült a rejtés."
        );
      }
    } catch (e) {
      applyLocal(job.hidden);
      window.alert(`Nem sikerült a rejtés: ${e.message}`);
    }
  };

  const resetManualAppliedForm = () => {
    setManualAppliedTitle("");
    setManualAppliedSource("");
    autoAppliedSourceRef.current = "";
    setManualAppliedUrl("");
    setManualAppliedDate(new Date().toISOString().slice(0, 10));
    setManualAppliedCompany("");
    setEditingAppliedKey(null);
  };

  // Cache-ből élő (kézzel felvitt vagy lejárt) jelentkezés szerkesztése:
  // a kézi felviteli űrlapot tölti fel az adataival, mentéskor a régi kulcs
  // helyére kerül az új (adminnál a DB-ben is).
  const startEditApplied = (key, job) => {
    setEditingAppliedKey(key);
    setManualAppliedTitle(job.title || "");
    setManualAppliedSource(job.source || "");
    autoAppliedSourceRef.current = "";
    setManualAppliedUrl(job.url || "");
    setManualAppliedCompany(job.company || "");
    setManualAppliedDate(job.firstSeen ? localDateStringFrom(job.firstSeen) : getTodayLocalDateString());
    setManualAppliedStatus("");
    setManualAddOpen(true);
    setTimeout(() => manualCardRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
  };

  const handleSaveManualApplied = () => {
    const title = manualAppliedTitle.trim();
    const source = manualAppliedSource.trim() || "manual";
    const url = normalizeJobUrl(manualAppliedUrl);
    if (!title) { setManualAppliedStatus("Adj meg legalább egy pozíció nevet"); return; }
    const editingKey = editingAppliedKey;
    const prevJob = editingKey ? appliedCache[editingKey] : undefined;
    // Változatlan dátumnál az eredeti időbélyeg marad (óra:perc nem vész el).
    const firstSeen =
      prevJob?.firstSeen && localDateStringFrom(prevJob.firstSeen) === manualAppliedDate
        ? prevJob.firstSeen
        : manualAppliedDate && /^\d{4}-\d{2}-\d{2}$/.test(manualAppliedDate)
        ? new Date(manualAppliedDate + "T00:00:00").toISOString()
        : new Date().toISOString();
    // A prevJob spread a nem szerkeszthető mezőket (description, experience)
    // őrzi meg lejárt állásoknál; az űrlapmezők felülírják a többit.
    const manualJob = {
      ...(prevJob || {}),
      source,
      title,
      url: url || undefined,
      firstSeen,
      company: manualAppliedCompany.trim() || undefined,
    };
    const key = jobKeyFor(manualJob);
    // A szerver 512 karakteres kulcsnál 400-zal elutasít — ilyenkor lokálisan
    // se mentsünk, különben a helyi lista és a DB szétcsúszik.
    if (key.length > 512) {
      setManualAppliedStatus("A link túl hosszú a mentéshez — rövidítsd le");
      return;
    }
    const wasInterview = editingKey ? interviewKeys.has(editingKey) : false;

    setAppliedKeys((prev) => {
      const next = new Set(prev);
      if (editingKey && editingKey !== key) next.delete(editingKey);
      next.add(key);
      saveAppliedKeys(next);
      return next;
    });
    setInterviewKeys((prev) => {
      if (!editingKey || editingKey === key) return prev;
      const next = new Set(prev);
      next.delete(editingKey);
      if (wasInterview) next.add(key);
      saveInterviewKeys(next);
      return next;
    });
    setAppliedCache((prev) => {
      const updated = { ...prev, [key]: manualJob };
      if (editingKey && editingKey !== key) delete updated[editingKey];
      saveAppliedCache(updated);
      return updated;
    });

    if (editingKey && editingKey !== key) {
      // Kulcs-csere a DB-ben: előbb az új sor, a régit csak sikeres beszúrás
      // után töröljük — hiba esetén a régi sor marad, nincs adatvesztés.
      persistAdminApplied(key, true, wasInterview, manualJob).then((ok) => {
        if (ok) persistAdminApplied(editingKey, false, false);
      });
    } else {
      persistAdminApplied(key, true, wasInterview, manualJob);
    }

    resetManualAppliedForm();
    setManualAppliedStatus(editingKey ? "Mentve" : "Hozzáadva");
  };

  const longPressTimerRef = useRef(null);
  const startLongPress = (target, localKey = target, clickedDate = getTodayLocalDateString()) => {
    clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = setTimeout(() => trackClick(target, localKey, clickedDate), 400);
  };
  const cancelLongPress = () => {
    clearTimeout(longPressTimerRef.current);
  };

  const trackClick = (target, localKey = target, clickedDate = getTodayLocalDateString()) => {
    setClickedKeys((prev) => {
      const next = new Set(prev);
      next.add(localKey);
      return next;
    });
    saveClickedKey(localKey);
    try {
      const visitorId = getOrCreateVisitorId();
      fetch(VISITOR_CLICK_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visitorId, target, clickedDate }),
      }).catch(() => {});
    } catch {
      // silent
    }
  };

  const [lastUpdates, setLastUpdates] = useState([]);
  const [showEmail, setShowEmail] = useState(false);
  const [monthlyActiveUsers, setMonthlyActiveUsers] = useState(null);

  useEffect(() => {
    fetch(VISITOR_TRACK_API)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data && typeof data.mau === "number") setMonthlyActiveUsers(data.mau);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(async () => {
      const today = getTodayLocalDateString();
      if (localStorage.getItem(DAILY_VISITOR_SENT_KEY) === today) return;
      try {
        const visitorId = getOrCreateVisitorId();
        await sendDailyVisitor(visitorId);
        localStorage.setItem(DAILY_VISITOR_SENT_KEY, today);
      } catch {
        // silent fail
      }
    }, ONE_MINUTE_MS);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    fetch("/.netlify/functions/last-deploy")
      .then((r) => r.json())
      .then((data) => {
        if (!Array.isArray(data?.updates)) return;
        setLastUpdates(
          data.updates
            .filter((u) => u?.date)
            .map((u) => ({ date: new Date(u.date) }))
        );
      })
      .catch(() => {});
  }, []);

  /* =======================
     FETCH
  ======================= */
  const fetchSources = async () => {
    setLoadingSources(true);
    try {
      const res = await fetch(`${API_BASE_URL}/jobs/sources`);
      const txt = await res.text();
      if (!res.ok) throw new Error(txt);
      setSources(JSON.parse(txt) || []);
    } catch {
      setSources([]);
    } finally {
      setLoadingSources(false);
    }
  };

  const fetchCategories = async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/categories`);
      const data = await res.json();
      if (Array.isArray(data)) {
        setJobCategories(data.map((c) => [c.name, c.keywords]));
      }
    } catch {
      setJobCategories([]);
    }
  };

  // Minden technológia, amit az extractTechnologies felismer — nem csak
  // ami az épp betöltött jobokban előfordul. Így egy tech akkor is
  // megjelenik (0 találattal) a chip-listában, ha még egyetlen betöltött
  // állásban sincs benne — amint bekerül egy új állásba, a chip magától
  // aktívvá válik, nem kell hozzá semmit újratölteni.
  const fetchTechnologies = async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/jobs/technologies`);
      const data = await res.json();
      if (Array.isArray(data)) setAllTechLabels(data);
    } catch {
      setAllTechLabels([]);
    }
  };

  const fetchJobs = async (next24h = time24h, next7d = time7d, force = false, nextToday = timeToday) => {
    let effectiveRange = null;
    // A "ma" a helyi éjfél óta eltelt idő, ami mindig < 24 óra, tehát a 24h-s
    // backend-lekérés mindig lefedi — a naptári napra szűkítés a lista-oldalon történik.
    if (nextToday) effectiveRange = TIME_RANGE_24H;
    else if (next24h && next7d) effectiveRange = "30d";
    else if (next7d) effectiveRange = TIME_RANGE_7D;
    else if (next24h) effectiveRange = TIME_RANGE_24H;

    const cacheKey = `jobWatcherJobsCache_${effectiveRange || "all"}`;
    const cacheTsKey = `${cacheKey}_ts`;
    const CACHE_TTL_MS = 5 * 60 * 1000; // 5 perc

    try {
      const cached = localStorage.getItem(cacheKey);
      const cachedTs = parseInt(localStorage.getItem(cacheTsKey) || "0", 10);
      if (!force && cached && Date.now() - cachedTs < CACHE_TTL_MS) {
        setJobs(JSON.parse(cached));
        setLoading(false);
        return;
      }
    } catch {
      // cache olvasás nem kritikus
    }

    setLoading(true);
    setStatus("");
    try {
      const params = new URLSearchParams({ limit: "5000" });
      if (effectiveRange) params.set("timeRange", effectiveRange);

      const res = await fetch(`${API_BASE_URL}/jobs?${params.toString()}`);
      const txt = await res.text();
      if (!res.ok) throw new Error(txt);
      const parsed = JSON.parse(txt) || [];
      setJobs(parsed);
      try {
        localStorage.setItem(cacheKey, JSON.stringify(parsed));
        localStorage.setItem(cacheTsKey, String(Date.now()));
      } catch {
        // localStorage quota exceeded, silent
      }
    } catch (e) {
      setStatus(`Hiba: ${e.message}`);
      setJobs([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSources();
    fetchCategories();
    fetchTechnologies();
  }, []);

  useEffect(() => {
    fetchJobs(time24h, time7d, false, timeToday);
  }, [time24h, time7d, timeToday]);

  /* Források/Kategóriák/Technológiák közül csak egy lehet nyitva egyszerre —
     az egyik megnyitása a másik kettőt automatikusan csukja. */
  const toggleSourcesSection = () => {
    setSourcesSectionOpen((prev) => {
      const next = !prev;
      if (next) {
        setCategoriesSectionOpen(false);
        setTechSectionOpen(false);
      }
      return next;
    });
  };

  const toggleCategoriesSection = () => {
    setCategoriesSectionOpen((prev) => {
      const next = !prev;
      if (next) {
        setSourcesSectionOpen(false);
        setTechSectionOpen(false);
      }
      return next;
    });
  };

  const toggleTechSection = () => {
    setTechSectionOpen((prev) => {
      const next = !prev;
      if (next) {
        setSourcesSectionOpen(false);
        setCategoriesSectionOpen(false);
      }
      return next;
    });
  };

  /* Category toggle (3-state) */
  const handleCategoryClick = (key) => {
    setCategoryStates((prev) => {
      const current = prev[key] || "neutral";
      const next =
        current === "neutral" ? "selected"
          : current === "selected" ? "excluded"
          : "neutral";
      const updated = { ...prev, [key]: next };
      localStorage.setItem("jobWatcherCategoryStates", JSON.stringify(updated));
      return updated;
    });
  };

  /* Egyetlen aktív kategória-szűrő eltávolítása (az "aktívak" összegző sorból) */
  const clearCategoryState = (key) => {
    setCategoryStates((prev) => {
      const updated = { ...prev };
      delete updated[key];
      localStorage.setItem("jobWatcherCategoryStates", JSON.stringify(updated));
      return updated;
    });
  };

  /* Category counts */
  const categoryCounts = useMemo(() => {
    const counts = {};
    for (const [cat] of jobCategories) counts[cat] = 0;
    counts["Egyéb"] = 0;
    for (const job of jobs) {
      const cats = getCategoriesForJob(job, jobCategories);
      if (cats.length === 0) {
        counts["Egyéb"]++;
      } else {
        for (const cat of cats) counts[cat]++;
      }
    }
    return counts;
  }, [jobs, jobCategories]);


  /* =======================
     TOGGLE HANDLERS
  ======================= */
  const handleSourceClick = (key) => {
    setSourceStates((prev) => {
      const current = prev[key] || "neutral";
      const next =
        current === "neutral"
          ? "selected"
          : current === "selected"
          ? "excluded"
          : "neutral";

      const updated = { ...prev, [key]: next };
      localStorage.setItem("jobWatcherSourceStates", JSON.stringify(updated));
      return updated;
    });
  };

  /* Egyetlen aktív forrás-szűrő eltávolítása (az "aktívak" összegző sorból) */
  const clearSourceState = (key) => {
    setSourceStates((prev) => {
      const updated = { ...prev };
      delete updated[key];
      localStorage.setItem("jobWatcherSourceStates", JSON.stringify(updated));
      return updated;
    });
  };

  /* Bulk: minden forrást azonos állapotba (selected = zöld, excluded = piros, neutral = törlés) */
  const setAllSources = (state) => {
    setSourceStates(() => {
      const updated = {};
      if (state !== "neutral") {
        for (const s of sources) updated[s.source] = state;
      }
      localStorage.setItem("jobWatcherSourceStates", JSON.stringify(updated));
      return updated;
    });
  };

  /* Bulk: minden kategóriát azonos állapotba */
  const setAllCategories = (state) => {
    setCategoryStates(() => {
      const updated = {};
      if (state !== "neutral") {
        const cats = jobCategories.map(([cat]) => cat).concat("Egyéb");
        for (const cat of cats) updated[cat] = state;
      }
      localStorage.setItem("jobWatcherCategoryStates", JSON.stringify(updated));
      return updated;
    });
  };

  const handleInternToggle = (checked) => {
    setInternMode(checked);
    localStorage.setItem("jobWatcherInternMode", checked);
    if (checked) {
      setJuniorMode(false);
      localStorage.setItem("jobWatcherJuniorMode", false);
      setMediorMode(false);
      localStorage.setItem("jobWatcherMediorMode", false);
      setSeniorMode(false);
      localStorage.setItem("jobWatcherSeniorMode", false);
    }
  };

  const handleJuniorToggle = (checked) => {
    setJuniorMode(checked);
    localStorage.setItem("jobWatcherJuniorMode", checked);
    if (checked) {
      setInternMode(false);
      localStorage.setItem("jobWatcherInternMode", false);
      setMediorMode(false);
      localStorage.setItem("jobWatcherMediorMode", false);
      setSeniorMode(false);
      localStorage.setItem("jobWatcherSeniorMode", false);
    }
  };

  const handleMediorToggle = (checked) => {
    setMediorMode(checked);
    localStorage.setItem("jobWatcherMediorMode", checked);
    if (checked) {
      setInternMode(false);
      localStorage.setItem("jobWatcherInternMode", false);
      setJuniorMode(false);
      localStorage.setItem("jobWatcherJuniorMode", false);
      setSeniorMode(false);
      localStorage.setItem("jobWatcherSeniorMode", false);
    }
  };

  const handleSeniorToggle = (checked) => {
    setSeniorMode(checked);
    localStorage.setItem("jobWatcherSeniorMode", checked);
    if (checked) {
      setInternMode(false);
      localStorage.setItem("jobWatcherInternMode", false);
      setJuniorMode(false);
      localStorage.setItem("jobWatcherJuniorMode", false);
      setMediorMode(false);
      localStorage.setItem("jobWatcherMediorMode", false);
    }
  };

  /* =======================
     SZŰRT LISTA
  ======================= */
  // Minden szűrő a TECH-szűrő ELŐTT (idő, keresés, gyakornok/junior/medior,
  // forrás, kategória) — ebből számolódnak a dinamikus tech chip-számok is,
  // így pl. gyakornok módban a Docker 0-t mutat, ha egyik gyakornoki pozi
  // sem tartalmazza.
  const preTechJobs = useMemo(() => {
    let list = jobs;

    const isJuniorTrackCandidate = (job) => {
      const t = (job.title || "").toLowerCase();
      const title = (job.title || "").toLowerCase();
      const source = (job.source || "").toLowerCase();
      const exp = (job.experience || "").toLowerCase();

      const internLike = INTERN_KEYWORDS.some((k) => t.includes(k));

      // Ha a forrás diákszövetkezet, akkor NE legyen junior/medior
      const isInternSource = JUNIOR_EXCLUDED_SOURCES.some((s) => source.includes(s));

      // Ha a cím tipikusan gyakornok/diák, akkor sem junior/medior
      const isInternTitle = INTERN_KEYWORDS.some((k) => title.includes(k));

      // Ha az experience gyakornok/diák jellegű, akkor sem junior/medior
      const isInternExp = INTERN_KEYWORDS.some((k) => exp.includes(k));

      // Ha az experience explicit junior, a cím-alapú intern szűrőket hagyjuk figyelmen kívül
      if (hasJuniorLevelToken(job.experience)) {
        return !isInternSource && !isInternExp;
      }

      return !isInternSource && !isInternTitle && !internLike && !isInternExp;
    };

    if (timeToday) {
      const todayStr = getTodayLocalDateString();
      list = list.filter((j) => j.firstSeen && localDateStringFrom(j.firstSeen) === todayStr);
    } else if (time24h && !time7d) {
      list = list.filter((j) => j.firstSeen && hoursSince(j.firstSeen) <= 24);
    } else if (time7d) {
      list = list.filter((j) => j.firstSeen && hoursSince(j.firstSeen) <= 24 * 7);
    }

    const nq = q.trim().toLowerCase();
    const activeSearchTerms = [...activeSavedSearches].filter((s) => savedSearches.includes(s));
    if (nq) {
      list = list.filter((j) => {
        const t = (j.title || "").toLowerCase();
        const c = (j.company || "").toLowerCase();
        return t.includes(nq) || c.includes(nq);
      });
    } else if (activeSearchTerms.length > 0) {
      list = list.filter((j) => {
        const t = (j.title || "").toLowerCase();
        const c = (j.company || "").toLowerCase();
        return activeSearchTerms.some((s) => {
          const sl = s.toLowerCase();
          return t.includes(sl) || c.includes(sl);
        });
      });
    }


    if (internMode) {
      list = list.filter((j) => {
        const source = (j.source || "").toLowerCase();
        const t = (j.title || "").toLowerCase();
        const exp = (j.experience || "").toLowerCase();
        const isInternSource = JUNIOR_EXCLUDED_SOURCES.some((s) => source.includes(s));
        const internLike = INTERN_KEYWORDS.some((k) => t.includes(k));
        const internExp = INTERN_KEYWORDS.some((k) => exp.includes(k));
        return (
          ((internLike || internExp) && !t.includes(JUNIOR_KEYWORD)) || isInternSource
        );
      });
    }

    if (juniorMode || mediorMode) {
      list = list.filter((j) => {
        if (!isJuniorTrackCandidate(j)) return false;

        const mediorInText = (j.title && j.title.toLowerCase().includes("medior")) || (j.description && j.description.toLowerCase().includes("medior"));

        // Ha medior szót tartalmaz ÉS az experience NEM explicit junior, CSAK medior szűrővel jelenjen meg
        if (mediorInText && !hasJuniorLevelToken(j.experience)) {
          return mediorMode;
        }

        // Egyébként a szokásos junior/medior logika
        const matchesJunior = juniorMode && isJuniorExperience(j.experience);
        const matchesMedior = mediorMode && isMediorExperience(j.experience);
        return matchesJunior || matchesMedior;
      });
    }

    // Alapból a senior-jelölésű állásokat elrejtjük; a "Csak senior" mód
    // megfordítja ezt, és KIZÁRÓLAG a senior-jelölésűeket mutatja.
    list = list.filter((j) => isSeniorExperience(j.experience) === seniorMode);

    const selected = Object.keys(sourceStates).filter(
      (k) => sourceStates[k] === "selected"
    );
    const excluded = Object.keys(sourceStates).filter(
      (k) => sourceStates[k] === "excluded"
    );

    if (selected.length) {
      list = list.filter((j) => selected.some((k) => jobMatchesSourceKey(j.source, k)));
    } else if (excluded.length) {
      list = list.filter((j) => !excluded.some((k) => jobMatchesSourceKey(j.source, k)));
    }

    const selectedCats = Object.keys(categoryStates).filter((k) => categoryStates[k] === "selected");
    const excludedCats = Object.keys(categoryStates).filter((k) => categoryStates[k] === "excluded");

    if (selectedCats.length) {
      list = list.filter((j) => {
        const cats = getCategoriesForJob(j, jobCategories);
        if (cats.length === 0) return selectedCats.includes("Egyéb");
        return cats.some((c) => selectedCats.includes(c));
      });
    } else if (excludedCats.length) {
      list = list.filter((j) => {
        const cats = getCategoriesForJob(j, jobCategories);
        if (cats.length === 0) return !excludedCats.includes("Egyéb");
        return !cats.some((c) => excludedCats.includes(c));
      });
    }

    return list;
  }, [jobs, q, time24h, time7d, timeToday, internMode, juniorMode, mediorMode, seniorMode, sourceStates, categoryStates, jobCategories, savedSearches, activeSavedSearches]);

  /* =======================
     TECHNOLÓGIA SZŰRŐ
  ======================= */
  // Globális előfordulás a betöltött listában — ez dönti el, hogy egy tech
  // egyáltalán LÉTEZIK-e (chip-lista + az alvó cache-elt szűrők ébresztése).
  const globalTechCounts = useMemo(() => {
    const counts = {};
    for (const job of jobs) {
      for (const tech of splitTechnologies(job.technologies)) {
        counts[tech] = (counts[tech] || 0) + 1;
      }
    }
    return counts;
  }, [jobs]);

  // Dinamikus (facet) számok: a tech-szűrőn KÍVÜL minden más aktív szűrő
  // utáni találatokból — gyakornok módban a Docker 0-t mutat, ha ott nincs.
  const techCounts = useMemo(() => {
    const counts = {};
    for (const job of preTechJobs) {
      for (const tech of splitTechnologies(job.technologies)) {
        counts[tech] = (counts[tech] || 0) + 1;
      }
    }
    return counts;
  }, [preTechJobs]);

  // Chipek: a teljes ismert tech-lista (allTechLabels, a backend
  // /jobs/technologies-ből — MINDEN felismerhető tech, függetlenül attól,
  // hogy van-e rá épp betöltött állás) UNIÓJA a betöltött jobokban ténylegesen
  // előforduló technológiákkal (globalTechCounts — legacy/eltérő címkék miatt
  // a biztonság kedvéért). Találatszám szerint csökkenő sorrendben (a chipen
  // látható darabszám alapján, ugyanaz a techCounts, amit a chip badge mutat),
  // holtverseny esetén abc — így a leggyakoribb technológiák elöl vannak.
  const techList = useMemo(() => {
    const labels = new Set(allTechLabels);
    for (const tech of Object.keys(globalTechCounts)) labels.add(tech);
    return [...labels].sort((a, b) => {
      const diff = (techCounts[b] || 0) - (techCounts[a] || 0);
      return diff !== 0 ? diff : a.localeCompare(b, "hu");
    });
  }, [allTechLabels, globalTechCounts, techCounts]);

  // A keresőmező csak a chip-lista MEGJELENÍTÉSÉT szűri — a state-eket
  // (kijelölés, számlálás) nem érinti, tehát egy elrejtett chip kijelölése
  // is megmarad, csak a keresés törlésekor látszik újra.
  const visibleTechList = useMemo(() => {
    const term = techSearch.trim().toLowerCase();
    if (!term) return techList;
    return techList.filter((tech) => tech.toLowerCase().includes(term));
  }, [techList, techSearch]);

  // Az épp aktív (nem semleges) forrás/kategória/tech szűrők EGY közös
  // csík-listája — ez jelenik meg egyszer, a teljes Források/Kategóriák/
  // Technológiák blokk fölött (nem szekciónként külön).
  const activeFilterChips = useMemo(() => {
    const srcChips = sources
      .filter((s) => (sourceStates[s.source] || "neutral") !== "neutral")
      .map((s) => ({
        key: `src-${s.source}`,
        label: s.label,
        state: sourceStates[s.source],
        onClear: () => clearSourceState(s.source),
      }));

    const catChips = jobCategories
      .map(([cat]) => cat)
      .concat("Egyéb")
      .filter((cat) => (categoryStates[cat] || "neutral") !== "neutral")
      .map((cat) => ({
        key: `cat-${cat}`,
        label: cat,
        state: categoryStates[cat],
        onClear: () => clearCategoryState(cat),
      }));

    const techChips = techList
      .filter((tech) => (techStates[tech] || "neutral") !== "neutral")
      .map((tech) => ({
        key: `tech-${tech}`,
        label: tech,
        state: techStates[tech],
        onClear: () => clearTechState(tech),
      }));

    return [...srcChips, ...catChips, ...techChips];
  }, [sources, sourceStates, jobCategories, categoryStates, techList, techStates]);

  // A Források/Kategóriák/Technológiák panelekben csak az eldöntetlen
  // (neutral) elemek látszanak — a kijelöltek (selected/excluded) fent, az
  // Aktív szűrők csíkban jelennek meg. Ha egy panelen belül MINDEN elem már
  // ki van jelölve, ez a lista üresen maradna magyarázat nélkül — ezt a
  // "Minden ... ki van jelölve" szöveg jelzi a panelben (ld. render).
  const neutralSources = useMemo(
    () => sources.filter((s) => (sourceStates[s.source] || "neutral") === "neutral"),
    [sources, sourceStates]
  );

  const neutralCategories = useMemo(
    () =>
      jobCategories
        .map(([cat]) => cat)
        .sort((a, b) => a.localeCompare(b, "hu"))
        .concat("Egyéb")
        .filter((cat) => (categoryStates[cat] || "neutral") === "neutral"),
    [jobCategories, categoryStates]
  );

  const neutralTechs = useMemo(
    () => visibleTechList.filter((tech) => (techStates[tech] || "neutral") === "neutral"),
    [visibleTechList, techStates]
  );

  /* Mentett keresés-chipek + aktív szűrő-chipek közös sora összecsukható,
     ha 1 sornál többre tördelődik (PC-n és mobilon is) — enélkül a sok
     forrás/kategória/tech chip könnyen lenyomja az oldal többi részét.
     A "hány sor" kérdést NEM lehet CSS-ből eldönteni (a chipek száma és a
     konténer szélessége is változó), ezért JS méri: a chip-sor gyerekeinek
     offsetTop-ját hasonlítjuk az első gyerekéhez — ha eltér, tördelt.
     ResizeObserver a konténeren figyeli az ablak-átméretezést IS (a szélesség
     változása a gyerekek reflow-ját okozza, még ha a konténer magassága
     összecsukott állapotban rögzített is). */
  const [chipsExpanded, setChipsExpanded] = useState(false);
  const [chipsOverflowing, setChipsOverflowing] = useState(false);
  const [chipsCollapsedHeight, setChipsCollapsedHeight] = useState(null);
  const chipsRowRef = useRef(null);

  useLayoutEffect(() => {
    const el = chipsRowRef.current;
    if (!el) return;
    const measure = () => {
      // .job-saved-searches / .job-active-summary vannak display:contents-ként
      // a chip-sorban, tehát el.children a KÉT wrapper divet adná vissza (0
      // offsetHeight-tel, mert display:contents nem generál dobozt) — a
      // TÉNYLEGES flex-item chipeket kell lekérdezni közvetlenül.
      const children = Array.from(el.querySelectorAll(".job-saved-chip, .job-active-chip"));
      if (children.length === 0) {
        setChipsOverflowing(false);
        setChipsCollapsedHeight(null);
        return;
      }
      // FONTOS: offsetTop az elem offsetParent-jéhez képest relatív, ami NEM
      // feltétlen maga `el` (mert `.job-chips-row`-nak nincs position-je) —
      // ezért offsetTop-tal számolva a "sor magassága" könnyen egy, az `el`
      // tetejétől távoli abszolút oldal-Y koordináta lett (pl. 554px egy
      // ténylegesen 364px magas tartalomnál), ami sosem vágta le semmit.
      // getBoundingClientRect()-tel MINDIG `el`-hez relatív értéket kapunk.
      const elTop = el.getBoundingClientRect().top;
      const firstTop = children[0].getBoundingClientRect().top;
      let overflow = false;
      let firstRowBottom = 0;
      children.forEach((c) => {
        const rect = c.getBoundingClientRect();
        if (rect.top > firstTop + 1) overflow = true;
        else firstRowBottom = Math.max(firstRowBottom, rect.bottom - elTop);
      });
      setChipsOverflowing(overflow);
      setChipsCollapsedHeight(firstRowBottom);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [savedSearches, activeSavedSearches, activeFilterChips]);

  /* Tech toggle (3-state). 0 találatos chip csak akkor kattintható, ha van
     rajta mentett állapot (hogy vissza lehessen venni) — újat nem lehet
     0-ra állítani. */
  const handleTechClick = (key) => {
    setTechStates((prev) => {
      const current = prev[key] || "neutral";
      const next =
        current === "neutral" ? "selected"
          : current === "selected" ? "excluded"
          : "neutral";
      const updated = { ...prev, [key]: next };
      localStorage.setItem("jobWatcherTechStates", JSON.stringify(updated));
      return updated;
    });
  };

  /* Egyetlen aktív tech-szűrő eltávolítása (az "aktívak" összegző sorból) */
  const clearTechState = (key) => {
    setTechStates((prev) => {
      const updated = { ...prev };
      delete updated[key];
      localStorage.setItem("jobWatcherTechStates", JSON.stringify(updated));
      return updated;
    });
  };

  /* Bulk: Mind ✓/✕ csak az ÉPP TALÁLATOS techekre áll be (a 0-sokat és az
     alvó cache-elt state-eket nem bántja); Törlés a teljes cache-t üríti. */
  const setAllTechs = (state) => {
    setTechStates((prev) => {
      let updated;
      if (state === "neutral") {
        updated = {};
      } else {
        updated = { ...prev };
        for (const tech of techList) {
          if ((techCounts[tech] || 0) > 0) updated[tech] = state;
        }
      }
      localStorage.setItem("jobWatcherTechStates", JSON.stringify(updated));
      return updated;
    });
  };

  /* Összes szűrő visszaállítása alaphelyzetbe — az "Nincs találat." nézet
     "Szűrők törlése" gombja hívja, hogy a szűrők kombinációja miatt beragadt
     (0 találatos) állapotból egy kattintással ki lehessen jönni. */
  const resetAllFilters = () => {
    setQ("");
    setActiveSavedSearches(new Set());
    localStorage.setItem("jobWatcherActiveSavedSearches", JSON.stringify([]));
    setInternMode(false);
    localStorage.setItem("jobWatcherInternMode", "false");
    setJuniorMode(false);
    localStorage.setItem("jobWatcherJuniorMode", "false");
    setMediorMode(false);
    localStorage.setItem("jobWatcherMediorMode", "false");
    setSeniorMode(false);
    localStorage.setItem("jobWatcherSeniorMode", "false");
    setTime24h(false);
    localStorage.setItem("jobWatcherTime24h", "false");
    setTime7d(false);
    localStorage.setItem("jobWatcherTime7d", "false");
    setTimeToday(true);
    localStorage.setItem("jobWatcherTimeToday", "true");
    setAllSources("neutral");
    setAllCategories("neutral");
    setAllTechs("neutral");
  };

  /* Emberi olvasható lista arról, mely szűrők vannak épp aktívan bekapcsolva
     — a "Nincs találat." üzenet ebből magyarázza meg, mi okozhatja a 0
     találatot (csak azok a tech-state-ek számítanak, amik ténylegesen
     szűrnek is, ld. visibleJobs fenti globalTechCounts > 0 feltétele). */
  const activeFilterReasons = useMemo(() => {
    const reasons = [];
    const nq = q.trim();
    if (nq) {
      reasons.push(`keresés: "${nq}"`);
    } else {
      const activeSearchTerms = [...activeSavedSearches].filter((s) => savedSearches.includes(s));
      if (activeSearchTerms.length) reasons.push(`mentett keresés: ${activeSearchTerms.join(", ")}`);
    }

    if (timeToday) reasons.push("időszűrő: ma");
    else if (time7d) reasons.push("időszűrő: 1 hét");
    else if (time24h) reasons.push("időszűrő: 24 óra");

    if (internMode) reasons.push("Gyakornok mód");
    if (juniorMode) reasons.push("Junior mód");
    if (mediorMode) reasons.push("Medior mód");
    if (seniorMode) reasons.push("Csak senior mód");

    const selectedSources = Object.keys(sourceStates).filter((k) => sourceStates[k] === "selected");
    const excludedSources = Object.keys(sourceStates).filter((k) => sourceStates[k] === "excluded");
    if (selectedSources.length) reasons.push(`${selectedSources.length} kiválasztott forrás`);
    else if (excludedSources.length) reasons.push(`${excludedSources.length} kizárt forrás`);

    const selectedCats = Object.keys(categoryStates).filter((k) => categoryStates[k] === "selected");
    const excludedCats = Object.keys(categoryStates).filter((k) => categoryStates[k] === "excluded");
    if (selectedCats.length) reasons.push(`${selectedCats.length} kiválasztott kategória`);
    else if (excludedCats.length) reasons.push(`${excludedCats.length} kizárt kategória`);

    const selectedTechs = Object.keys(techStates).filter((k) => techStates[k] === "selected" && globalTechCounts[k] > 0);
    const excludedTechs = Object.keys(techStates).filter((k) => techStates[k] === "excluded" && globalTechCounts[k] > 0);
    if (selectedTechs.length) reasons.push(`${selectedTechs.length} kiválasztott technológia`);
    else if (excludedTechs.length) reasons.push(`${excludedTechs.length} kizárt technológia`);

    return reasons;
  }, [q, activeSavedSearches, savedSearches, time24h, time7d, timeToday, internMode, juniorMode, mediorMode, seniorMode, sourceStates, categoryStates, techStates, globalTechCounts]);

  const visibleJobs = useMemo(() => {
    let list = preTechJobs;

    // Technológia-szűrés — a cache-elt state-ekből CSAK a betöltött listában
    // létező technológiák szűrnek; a többi alszik, amíg újra nem lesz olyan
    // munka.
    const selectedTechs = Object.keys(techStates).filter(
      (k) => techStates[k] === "selected" && globalTechCounts[k] > 0
    );
    const excludedTechs = Object.keys(techStates).filter(
      (k) => techStates[k] === "excluded" && globalTechCounts[k] > 0
    );

    if (selectedTechs.length) {
      list = list.filter((j) =>
        splitTechnologies(j.technologies).some((t) => selectedTechs.includes(t))
      );
    } else if (excludedTechs.length) {
      list = list.filter(
        (j) => !splitTechnologies(j.technologies).some((t) => excludedTechs.includes(t))
      );
    }

    if (showAppliedOnly) {
      const apiKeys = new Set(list.map(jobKeyFor));

      // A kereső/mentett-keresés szűrőt preTechJobs már alkalmazta a listára,
      // de a cache-ből visszaszedett (API-listából már kikerült) jelentkezésekre
      // NEM — azokra itt kell újra, különben a kereső figyelmen kívül hagyná
      // az összes ilyen régi jelentkezést, és mindig az összesre "hatna".
      const nq = q.trim().toLowerCase();
      const activeSearchTerms = [...activeSavedSearches].filter((s) => savedSearches.includes(s));
      const matchesSearch = (j) => {
        const t = (j.title || "").toLowerCase();
        const c = (j.company || "").toLowerCase();
        if (nq) return t.includes(nq) || c.includes(nq);
        if (activeSearchTerms.length > 0) {
          return activeSearchTerms.some((s) => {
            const sl = s.toLowerCase();
            return t.includes(sl) || c.includes(sl);
          });
        }
        return true;
      };

      // Applied jobs no longer in the API list (expired / manual adds) come
      // from the cache, matched by their STORED key so legacy entries render.
      // cachedOnly + storedKey: ezekre jelenik meg a Szerkesztés gomb, és a
      // mentés a tárolt kulcsot cseréli (compactJob mindkettőt kiszűri a DB-ből).
      const onlyCached = Object.entries(appliedCache)
        .filter(([key]) => appliedKeys.has(key) && !apiKeys.has(key))
        .map(([key, j]) => ({ ...j, cachedOnly: true, storedKey: key }))
        .filter(matchesSearch);
      list = [...list.filter((j) => appliedKeys.has(jobKeyFor(j))), ...onlyCached];
    }

    return [...list].sort(
      (a, b) =>
        new Date(b.firstSeen || 0) - new Date(a.firstSeen || 0)
    );
  }, [preTechJobs, techStates, globalTechCounts, showAppliedOnly, appliedKeys, appliedCache, q, activeSavedSearches, savedSearches]);

  const activeTimeLabel = timeToday
    ? "ma"
    : time7d
    ? "1 hét"
    : time24h
    ? "24h"
    : "nincs";

  // Csak azokat tudjuk megnyitni, amiknek van linkjük.
  const openableJobs = useMemo(
    () => visibleJobs.filter((j) => j.url),
    [visibleJobs]
  );

  /* Bulk: az összes leszűrt állás megnyitása új lapokon + mindet "megtekintettnek"
     jelöl — pontosan úgy, mintha egyenként rákattintottál volna (trackClick). */
  const openAllFiltered = () => {
    if (openableJobs.length === 0) return;
    if (openableJobs.length > 100) {
      window.alert(
        `Egyszerre legfeljebb 100 állást lehet megnyitni, most ${openableJobs.length} lenne. Szűkíts a szűrőkkel, mielőtt megnyitod őket.`
      );
      return;
    }
    if (
      openableJobs.length > 12 &&
      !window.confirm(
        `${openableJobs.length} állást nyitok meg új lapokon, és mindet „megtekintett” állapotba teszem. Biztos?\n\n(Lehet, hogy engedélyezned kell a felugró ablakokat ehhez az oldalhoz.)`
      )
    ) {
      return;
    }
    const clickedDate = getTodayLocalDateString();
    for (const job of openableJobs) {
      const key = `job:${job.source}:${job.title}`;
      window.open(job.url, "_blank", "noopener,noreferrer");
      trackClick(key, key, clickedDate);
    }
  };

  /* =======================
     RENDER
  ======================= */
  return (
  <div className="job-watcher">
    <div className="job-watcher-header">
      <div>
          <h1>Automata scraper</h1>
          <p>Minden nap UTC szerint 5-22 között óránként frissül. Kivéve az AI agentek, azok reggel futnak, ha van még tokenem.</p>
          <div className="job-linkedin-notice">
            <span className="job-linkedin-notice__title">⚠️ Figyelem — LinkedIn</span>
            <p>
              A LinkedIn állások <strong>~50%-át</strong> tudjuk csak
              megjeleníteni, mert a publikus API-k erősen korlátozottak.
            </p>
          </div>
          <div className="job-last-deploy">
            {lastUpdates.length > 0 ? (
              <span>
                {`Last git commit: ${lastUpdates[0].date.toLocaleString("hu-HU", { dateStyle: "short", timeStyle: "short" })}`}
              </span>
            ) : (
              <span>Nincs elérhető frissítési dátum.</span>
            )}
          </div>
      </div>

      <div className="job-actions">
        <div className="job-search-wrap">
          <span className="job-search-icon" aria-hidden="true">🔍</span>
          <input
            className="job-search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Keresés pozícióra vagy cégre…"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const term = q.trim();
                if (term && !savedSearches.includes(term)) {
                  const nextSaved = [...savedSearches, term];
                  setSavedSearches(nextSaved);
                  localStorage.setItem("jobWatcherSavedSearches", JSON.stringify(nextSaved));
                  const nextActive = new Set(activeSavedSearches);
                  nextActive.add(term);
                  setActiveSavedSearches(nextActive);
                  localStorage.setItem("jobWatcherActiveSavedSearches", JSON.stringify([...nextActive]));
                  // NEM ürítjük ki a mezőt: amíg q nem üres, a szűrés KIZÁRÓLAG
                  // erre a szövegre megy (ld. preTechJobs) — ha itt kitörölnénk,
                  // a lista visszaesne a MÁR aktív mentett keresések uniójára,
                  // és korábbi (elfelejtett bekapcsolt) chipek is visszaszivárognának.
                }
              }
            }}
          />
        </div>
        <div className="job-action-btns">
          {q.trim() && !savedSearches.includes(q.trim()) && (
            <button
              className="job-btn job-btn--save-search"
              onClick={() => {
                const term = q.trim();
                const nextSaved = [...savedSearches, term];
                setSavedSearches(nextSaved);
                localStorage.setItem("jobWatcherSavedSearches", JSON.stringify(nextSaved));
                const nextActive = new Set(activeSavedSearches);
                nextActive.add(term);
                setActiveSavedSearches(nextActive);
                localStorage.setItem("jobWatcherActiveSavedSearches", JSON.stringify([...nextActive]));
                setQ("");
              }}
              title="Keresési szó mentése"
            >
              + Mentés
            </button>
          )}
          <button
            className={`job-btn job-btn--toggle${showAppliedOnly ? " active" : ""}`}
            onClick={() => setShowAppliedOnly((v) => !v)}
          >
            {showAppliedOnly ? `✓ Jelentkezések (${appliedKeys.size})` : `Jelentkezések (${appliedKeys.size})`}
          </button>
          <button className="job-btn job-btn-stats" onClick={() => navigate("/allasfigyelo/stats")}>
           📊 Statisztikák
          </button>
          <button className="job-btn" onClick={() => fetchJobs(time24h, time7d, true)}>
            Frissítés
          </button>
          <button
            className="job-btn job-btn--openall"
            onClick={openAllFiltered}
            disabled={openableJobs.length === 0}
            title="Az összes leszűrt állást megnyitja új lapokon, és megtekintettnek jelöli (mintha egyenként rákattintottál volna)"
          >
            🚀 Mind megnyitása ({openableJobs.length})
          </button>
        </div>

        {(savedSearches.length > 0 || activeFilterChips.length > 0) && (
          <div className="job-saved-and-active">
            <span className="job-filter-group-label">Aktív szűrők</span>
            <div
              className="job-chips-row"
              ref={chipsRowRef}
              style={
                !chipsExpanded && chipsOverflowing && chipsCollapsedHeight
                  ? { maxHeight: chipsCollapsedHeight, overflow: "hidden" }
                  : undefined
              }
            >
            {savedSearches.length > 0 && (
              <div className="job-saved-searches">
                {savedSearches.map((s) => {
                  const isActive = activeSavedSearches.has(s);
                  return (
                    <span key={s} className={`job-saved-chip${isActive ? " active" : ""}`}>
                      <button
                        className="job-saved-chip-label"
                        onClick={() => {
                          const next = new Set(activeSavedSearches);
                          if (isActive) next.delete(s); else next.add(s);
                          setActiveSavedSearches(next);
                          localStorage.setItem("jobWatcherActiveSavedSearches", JSON.stringify([...next]));
                        }}
                        title={isActive ? "Szűrő kikapcsolása" : "Szűrő bekapcsolása"}
                      >
                        {s}
                      </button>
                      <button
                        className="job-saved-chip-remove"
                        onClick={() => {
                          const nextSaved = savedSearches.filter((x) => x !== s);
                          setSavedSearches(nextSaved);
                          localStorage.setItem("jobWatcherSavedSearches", JSON.stringify(nextSaved));
                          const nextActive = new Set(activeSavedSearches);
                          nextActive.delete(s);
                          setActiveSavedSearches(nextActive);
                          localStorage.setItem("jobWatcherActiveSavedSearches", JSON.stringify([...nextActive]));
                        }}
                        title="Törlés"
                      >
                        ×
                      </button>
                    </span>
                  );
                })}
              </div>
            )}
            {/* ===== AKTÍV SZŰRŐK (forrás + kategória + tech összesítve) ===== */}
            <ActiveFilterSummary items={activeFilterChips} />
            </div>
            {chipsOverflowing && (
              <button
                type="button"
                className="job-chips-toggle"
                onClick={() => setChipsExpanded((v) => !v)}
              >
                {chipsExpanded ? "▲ Kevesebb" : "▼ Több"}
              </button>
            )}
          </div>
        )}

        <div className="job-filters">
          <div className="job-filter-group job-filter-group--level">
          <span className="job-filter-group-label">Szint</span>
          <label className="job-checkbox">
            <input
              type="checkbox"
              checked={internMode}
              onChange={(e) => handleInternToggle(e.target.checked)}
            />
            Gyakornok
          </label>

          <label className="job-checkbox">
            <input
              type="checkbox"
              checked={juniorMode}
              onChange={(e) => handleJuniorToggle(e.target.checked)}
            />
            Junior
          </label>

          <label className="job-checkbox">
            <input
              type="checkbox"
              checked={mediorMode}
              onChange={(e) => handleMediorToggle(e.target.checked)}
            />
            Medior
          </label>

          <label className="job-checkbox">
            <input
              type="checkbox"
              checked={seniorMode}
              onChange={(e) => handleSeniorToggle(e.target.checked)}
            />
            Senior
          </label>
          </div>

          <div className="job-filter-group job-filter-group--time">
          <span className="job-filter-group-label">Frissesség</span>
          <label className="job-checkbox">
            <input
              type="checkbox"
              checked={timeToday}
              onChange={(e) => {
                setTimeToday(e.target.checked);
                localStorage.setItem("jobWatcherTimeToday", String(e.target.checked));
                if (e.target.checked) {
                  setTime24h(false);
                  localStorage.setItem("jobWatcherTime24h", "false");
                  setTime7d(false);
                  localStorage.setItem("jobWatcherTime7d", "false");
                }
              }}
            />
            Mai
          </label>

          <label className="job-checkbox">
            <input
              type="checkbox"
              checked={time24h}
              onChange={(e) => {
                setTime24h(e.target.checked);
                localStorage.setItem("jobWatcherTime24h", String(e.target.checked));
                if (e.target.checked) {
                  setTime7d(false);
                  localStorage.setItem("jobWatcherTime7d", "false");
                  setTimeToday(false);
                  localStorage.setItem("jobWatcherTimeToday", "false");
                }
              }}
            />
            Új (24h)
          </label>

          <label className="job-checkbox">
            <input
              type="checkbox"
              checked={time7d}
              onChange={(e) => {
                setTime7d(e.target.checked);
                localStorage.setItem("jobWatcherTime7d", String(e.target.checked));
                if (e.target.checked) {
                  setTime24h(false);
                  localStorage.setItem("jobWatcherTime24h", "false");
                  setTimeToday(false);
                  localStorage.setItem("jobWatcherTimeToday", "false");
                }
              }}
            />
            Új (1 hét)
          </label>

          <label className="job-checkbox">
            <input
              type="checkbox"
              checked={!timeToday && !time24h && !time7d}
              onChange={(e) => {
                if (e.target.checked) {
                  setTimeToday(false);
                  localStorage.setItem("jobWatcherTimeToday", "false");
                  setTime24h(false);
                  localStorage.setItem("jobWatcherTime24h", "false");
                  setTime7d(false);
                  localStorage.setItem("jobWatcherTime7d", "false");
                }
              }}
            />
            Összes
          </label>
          </div>
        </div>
      </div>
    </div>

    {/* ===== SZŰRŐK VÁLASZTÓ =====
        Ugyanaz a minta, mint a Szint/Frissesség soroké fentebb: sötét kártya,
        zöld nagybetűs címke, utána lapos pill-gombok. A Források/Kategóriák/
        Technológiák pill zöldre vált, ha a saját tartalma épp nyitva van —
        ez maga a nyitó/csukó vezérlő, nincs mellette külön gomb. Egyszerre
        csak egy lehet nyitva (a toggle-ök becsukják a másik kettőt). */}
    <div className="job-filter-group">
      <span className="job-filter-group-label">Szűrők</span>
      <button
        className={`job-filter-group-btn${sourcesSectionOpen ? " active" : ""}`}
        onClick={toggleSourcesSection}
      >
        Források
      </button>
      <button
        className={`job-filter-group-btn${categoriesSectionOpen ? " active" : ""}`}
        onClick={toggleCategoriesSection}
      >
        Kategóriák
      </button>
      {techList.length > 0 && (
        <button
          className={`job-filter-group-btn${techSectionOpen ? " active" : ""}`}
          onClick={toggleTechSection}
        >
          Technológiák
        </button>
      )}
    </div>

    {/* ===== FORRÁSOK TARTALOM ===== */}
    {sourcesSectionOpen && (
      <div className="job-filters-panel">
        <div className="job-bulk-actions">
          <button className="job-bulk-btn job-bulk-btn--green" onClick={() => setAllSources("selected")}>Mind ✓</button>
          <button className="job-bulk-btn job-bulk-btn--red" onClick={() => setAllSources("excluded")}>Mind ✕</button>
          <button className="job-bulk-btn" onClick={() => setAllSources("neutral")}>Törlés</button>
        </div>
        <div className="job-tabs">
          {loadingSources ? (
            <div className="job-status">Források betöltése…</div>
          ) : sources.length > 0 && neutralSources.length === 0 ? (
            <div className="job-status">Minden forrás ki van jelölve — mind ott van fent az Aktív szűrők között.</div>
          ) : (
            // A már kijelölt (selected/excluded) források a fenti "Aktív
            // szűrők" csíkban jelennek meg — itt csak a még eldöntetlen
            // (neutral) források látszanak, hogy ne legyen duplikált a lista.
            neutralSources.map((s) => (
              <button
                key={s.source}
                className="job-tab"
                onClick={() => handleSourceClick(s.source)}
              >
                {s.label}
                {typeof s.count === "number" && (
                  <span className="job-tab-count">{s.count}</span>
                )}
              </button>
            ))
          )}
        </div>
      </div>
    )}

    {/* ===== KATEGÓRIÁK TARTALOM ===== */}
    {categoriesSectionOpen && (
      <div className="job-filters-panel">
        <div className="job-bulk-actions">
          <button className="job-bulk-btn job-bulk-btn--green" onClick={() => setAllCategories("selected")}>Mind ✓</button>
          <button className="job-bulk-btn job-bulk-btn--red" onClick={() => setAllCategories("excluded")}>Mind ✕</button>
          <button className="job-bulk-btn" onClick={() => setAllCategories("neutral")}>Törlés</button>
        </div>
        <div className="job-tabs">
          {/* A már kijelölt (selected/excluded) kategóriák a fenti "Aktív
              szűrők" csíkban jelennek meg — itt csak a még eldöntetlen
              (neutral) kategóriák látszanak, hogy ne legyen duplikált a lista. */}
          {jobCategories.length > 0 && neutralCategories.length === 0 ? (
            <div className="job-status">Minden kategória ki van jelölve — mind ott van fent az Aktív szűrők között.</div>
          ) : (
            neutralCategories.map((cat) => (
              <button key={cat} className="job-tab" onClick={() => handleCategoryClick(cat)}>
                {cat}
                <span className="job-tab-count">{categoryCounts[cat]}</span>
              </button>
            ))
          )}
        </div>
      </div>
    )}

    {/* ===== TECHNOLÓGIÁK TARTALOM ===== */}
    {techSectionOpen && techList.length > 0 && (
      <div className="job-filters-panel">
        <div className="job-bulk-actions">
          <button className="job-bulk-btn job-bulk-btn--green" onClick={() => setAllTechs("selected")}>Mind ✓</button>
          <button className="job-bulk-btn job-bulk-btn--red" onClick={() => setAllTechs("excluded")}>Mind ✕</button>
          <button className="job-bulk-btn" onClick={() => setAllTechs("neutral")}>Törlés</button>
        </div>

        <div className="job-search-wrap job-tech-search-wrap">
          <span className="job-search-icon" aria-hidden="true">🔍</span>
          <input
            className="job-search job-tech-search"
            value={techSearch}
            onChange={(e) => setTechSearch(e.target.value)}
            placeholder="Technológia keresése…"
          />
        </div>

        {/* A már kijelölt (selected/excluded) technológiák a fenti "Aktív
            szűrők" csíkban jelennek meg — itt csak a még eldöntetlen
            (neutral) technológiák látszanak, hogy ne legyen duplikált a lista.
            Két külön "üres" ok van: a keresés nem talál semmit, VAGY minden
            találat már ki van jelölve fent — ezeket külön szöveg jelzi. */}
        {visibleTechList.length === 0 ? (
          <div className="job-status">Nincs egyező technológia.</div>
        ) : (
          neutralTechs.length === 0 && (
            <div className="job-status">Minden technológia ki van jelölve — mind ott van fent az Aktív szűrők között.</div>
          )
        )}
        <div className="job-tabs">
          {neutralTechs.map((tech) => {
            const count = techCounts[tech] || 0;
            // 0 találatos chip is kattintható (előre kijelölhető egy még
            // egyetlen betöltött állásban sem szereplő technológia is) —
            // csak vizuálisan halványabb, jelezve, hogy épp "alszik":
            // amint lesz rá találat, a szűrő magától életbe lép.
            const cls = count === 0 ? "job-tab job-tab--sleeping" : "job-tab";
            return (
              <button
                key={tech}
                className={cls}
                onClick={() => handleTechClick(tech)}
              >
                {tech}
                <span className="job-tab-count">{count}</span>
              </button>
            );
          })}
        </div>
      </div>
    )}

    <div className="job-toolbar-footer">
      <button className="job-btn" onClick={resetAllFilters} title="Az összes szűrőt alaphelyzetbe állítja">
        Szűrők törlése
      </button>

      {/* ===== TALÁLATOK ===== */}
      {!loading && (
        <div className="job-status">
          Aktív időszűrő: {activeTimeLabel} · Találatok: {visibleJobs.length}
        </div>
      )}
    </div>

    {loading ? (
      <div className="job-status">Betöltés…</div>
    ) : visibleJobs.length === 0 && !showAppliedOnly ? (
      <div className="job-status job-status--empty">
        <p>Nincs találat.</p>
        {activeFilterReasons.length > 0 && (
          <p className="job-empty-reason">
            Ezt az aktív szűrőid okozhatják: {activeFilterReasons.join(", ")}.
          </p>
        )}
      </div>
    ) : (
      <ul className="job-list">
        {visibleJobs.map((job) => {
          const isNew =
            job.firstSeen && hoursSince(job.firstSeen) <= 1;
          const notes = getKeywordNotesForJob(job);
          const rowKey = `${job.source || "src"}-${job.url || job.title}-${job.firstSeen || "ts"}`;
          const clickKeyBase = `job:${job.source}:${job.title}`;
          const clickTarget = clickKeyBase;
          const clickDate = getTodayLocalDateString();
          // Applied/interview marks are url-keyed (title alone collides when
          // two companies post the same position); visited stays title-keyed
          // because the analytics targets already use that format.
          const appliedKey = jobKeyFor(job);
          const isVisited = clickedKeys.has(clickKeyBase);
          const isApplied = appliedKeys.has(appliedKey);
          const isInterview = interviewKeys.has(appliedKey);
          const isInactive = job.active === false;
          // `hidden` only ever arrives on a little-admin response (jobs.js sends
          // the column to nobody else), so this badge simply never renders for
          // ordinary visitors.
          const isHidden = job.hidden === true;
          const isHighlighted = highlightedKeys.has(appliedKey);

          return (
            <li key={rowKey} className={`job-card${isVisited ? " job-card--visited" : ""}${isApplied ? " job-card--applied" : ""}${isInterview ? " job-card--interview" : ""}${isInactive ? " job-card--inactive" : ""}${isHidden ? " job-card--hidden" : ""}${isHighlighted ? " job-card--highlighted" : ""}`}>
              <div className="job-row">
                <div className="job-title-group">
                  <a
                    className="job-title"
                    href={job.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => trackClick(clickTarget, clickKeyBase, clickDate)}
                    onAuxClick={(e) => { if (e.button === 1) trackClick(clickTarget, clickKeyBase, clickDate); }}
                    onContextMenu={() => trackClick(clickTarget, clickKeyBase, clickDate)}
                    onTouchStart={() => startLongPress(clickTarget, clickKeyBase, clickDate)}
                    onTouchEnd={cancelLongPress}
                    onTouchMove={cancelLongPress}
                    onTouchCancel={cancelLongPress}
                  >
                    {job.title}
                    {debugMode && (
                      <span style={{ color: "#f50b0b", marginLeft: 6, fontSize: "0.85em" }}>
                        [{getCategoriesForJob(job, jobCategories).join(", ") || "Egyéb"}]
                      </span>
                    )}
                  </a>
                  {job.company && (
                    <span className="job-company">[ {job.company} ]</span>
                  )}
                  {isInactive && (
                    <span className="job-inactive-badge" title="Ez az állás már nem szerepel a forrás listáján">
                      Lejárt
                    </span>
                  )}
                  {isHidden && (
                    <span className="job-hidden-badge" title="Rejtett – csak a megjelölt eszközön látszik, sima látogató nem kapja meg">
                      Rejtett
                    </span>
                  )}
                  {isHighlighted && (
                    <span className="job-highlight-badge" title="Kiemelve – ez csak a te eszközödön látszik így, senki másnak">
                      Kiemelt
                    </span>
                  )}
                </div>
                <span className="job-source">{displaySource(job.source)}</span>
              </div>

              {job.description && (
                <div className="job-desc">{job.description}</div>
              )}

              {notes.length > 0 && (
                <div className="job-note">
                  💭 Megjegyzés:
                  <ul>
                    {notes.map((n, i) => (
                      <li key={i}>{n}</li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="job-meta">
                {isNew && <span className="job-badge">Új</span>}
                {isSeniorExperience(job.experience) && (
                  <span
                    className="job-senior-badge"
                    title="Minimum tapasztalat ≥ 5 év — valószínűleg nem belépő/junior szint"
                  >
                    ⚠ Senior
                  </span>
                )}
                {job.experience && (
                  <span
                    className={
                      "job-experience" +
                      (isSeniorExperience(job.experience) ? " job-experience--senior" : "")
                    }
                  >
                    {job.experience}
                  </span>
                )}
                {job.technologies && (
                  <span className="job-tech-tags">
                    {job.technologies.split(", ").map((tech) => (
                      <span key={tech} className="job-tech-tag">{tech}</span>
                    ))}
                  </span>
                )}
                <span>
                  {job.firstSeen
                    ? new Date(job.firstSeen).toLocaleString("hu-HU")
                    : "—"}
                </span>
                {(isVisited || isApplied) && (
                  <button
                    className={`job-applied-btn${isApplied ? " applied" : ""}`}
                    onClick={() => toggleApplied(appliedKey, job)}
                    title={isApplied ? "Jelentkezés visszavonása" : "Megjelölés: Jelentkeztem"}
                  >
                    {isApplied ? "✓ Jelentkeztem" : "Jelentkeztem?"}
                  </button>
                )}
                {isApplied && (
                  <label
                    className={`job-interview-check${isInterview ? " checked" : ""}`}
                    title={isInterview ? "Interjú visszavonása" : "Megjelölés: Interjú"}
                  >
                    <input
                      type="checkbox"
                      checked={isInterview}
                      onChange={() => toggleInterview(appliedKey, job)}
                    />
                    {isInterview ? "✓ Interjú" : "Interjú"}
                  </label>
                )}
                {job.cachedOnly && (
                  <button
                    className="job-edit-btn"
                    onClick={() => startEditApplied(job.storedKey || appliedKey, job)}
                    title="Kézzel felvitt / lejárt jelentkezés adatainak szerkesztése"
                  >
                    ✎ Szerkesztés
                  </button>
                )}
                <button
                  className={`job-highlight-btn${isHighlighted ? " job-highlight-btn--on" : ""}${(isVisited || isApplied) ? "" : " job-highlight-btn--pushed"}`}
                  onClick={() => toggleHighlight(appliedKey)}
                  title={
                    isHighlighted
                      ? "Kiemelés visszavonása (csak ezen az eszközön)"
                      : "Kiemelés (csak ezen az eszközön, senki más nem látja)"
                  }
                >
                  {isHighlighted ? "★ Kiemelve" : "☆ Kiemelés"}
                </button>
                {(isLittleAdmin || isAdmin) && job.url && (
                  <button
                    className={`job-hide-btn${isHidden ? " job-hide-btn--on" : ""}`}
                    onClick={() => toggleHidden(job)}
                    title={
                      isHidden
                        ? "Visszaállítás: újra látszik a nyilvános listán"
                        : "Elrejtés a nyilvános listáról (a jelentkezés státuszt nem érinti)"
                    }
                  >
                    {isHidden ? "👁 Visszaállítás" : "🚫 Elrejtés"}
                  </button>
                )}
              </div>
            </li>
          );
        })}

        {visibleJobs.length === 0 && showAppliedOnly && (
          <li className="job-status">Még nincs mentett jelentkezés.</li>
        )}

        {showAppliedOnly && (
          <li
            ref={manualCardRef}
            className={`job-card job-card--manual-add${manualAddOpen ? " open" : ""}`}
            onClick={!manualAddOpen ? () => { setManualAddOpen(true); setManualAppliedStatus(""); } : undefined}
          >
            <span className="job-card-fold" aria-hidden="true" />
            <button
              type="button"
              className="job-manual-toggle"
              onClick={(e) => {
                e.stopPropagation();
                // Bezárás szerkesztés közben = a szerkesztés megszakítása.
                if (manualAddOpen && editingAppliedKey) resetManualAppliedForm();
                setManualAddOpen(!manualAddOpen);
                setManualAppliedStatus("");
              }}
            >
              <span className="job-manual-cta">
                <strong>{editingAppliedKey ? "Jelentkezés szerkesztése" : "Kézileg hozzáadott jelentkezés"}</strong>
              </span>
              <span className="job-source">{manualAddOpen ? "Nyitva" : "Megnyitás"}</span>
            </button>

            {manualAddOpen && (
              <div onClick={(e) => e.stopPropagation()}>
                <div className="job-manual-fields">
                  <input
                    className="job-search"
                    value={manualAppliedTitle}
                    onChange={(e) => setManualAppliedTitle(e.target.value)}
                    placeholder="Pozíció neve (kötelező)"
                  />
                  <input
                    className="job-search"
                    value={manualAppliedSource}
                    onChange={(e) => setManualAppliedSource(e.target.value)}
                    placeholder="Forrás (pl: profession)"
                  />
                  <input
                    className="job-search"
                    value={manualAppliedUrl}
                    onBlur={() => setManualAppliedUrl((v) => normalizeJobUrl(v) || v)}
                    onChange={(e) => {
                      const v = e.target.value;
                      setManualAppliedUrl(v);
                      const derived = sourceFromUrl(v);
                      if (
                        derived &&
                        (!manualAppliedSource.trim() ||
                          manualAppliedSource === autoAppliedSourceRef.current)
                      ) {
                        setManualAppliedSource(derived);
                        autoAppliedSourceRef.current = derived;
                      }
                    }}
                    placeholder="Link (opcionális)"
                  />
                  <input
                    className="job-search"
                    value={manualAppliedCompany}
                    onChange={(e) => setManualAppliedCompany(e.target.value)}
                    placeholder="Cégnév (opcionális)"
                  />
                  <label className="job-manual-date-label">
                    <span>Jelentkezés dátuma</span>
                    <div className="job-manual-date-wrapper">
                      <span className="job-manual-date-icon">&#128197;</span>
                      <input
                        type="text"
                        className="job-search job-manual-date"
                        value={manualAppliedDate}
                        onChange={(e) => setManualAppliedDate(e.target.value)}
                        placeholder="YYYY-MM-DD"
                        pattern="\d{4}-\d{2}-\d{2}"
                        maxLength={10}
                      />
                    </div>
                  </label>
                </div>
                <div className="job-meta job-manual-submit-row">
                  <span style={{ color: manualAppliedStatus === "Hozzáadva" || manualAppliedStatus === "Mentve" ? "#4ade80" : "#ef4444" }}>{manualAppliedStatus}</span>
                  {editingAppliedKey && (
                    <button
                      className="job-btn"
                      onClick={() => { resetManualAppliedForm(); setManualAppliedStatus(""); }}
                    >
                      Mégse
                    </button>
                  )}
                  <button className="job-btn job-btn--green" onClick={handleSaveManualApplied}>
                    {editingAppliedKey ? "Mentés" : "Hozzáadás"}
                  </button>
                </div>
              </div>
            )}
          </li>
        )}
      </ul>
    )}

    {/* ICON SOR */}
    <div className="social-icons">
      <div className={`email-block ${showEmail ? "open" : ""}`}>
        <button
          className="icon-button"
          onClick={() => setShowEmail((v) => !v)}
          aria-label="Email"
        >
          <FaEnvelope />
        </button>
        <span className="email-reveal">bak.andrs@gmail.com</span>
      </div>

      <a
        href="https://www.linkedin.com/in/andras-bako123/"
        target="_blank"
        rel="noopener noreferrer"
        aria-label="LinkedIn"
        className="icon-button icon-button-linkedin"
      >
        <FaLinkedin />
      </a>

      {monthlyActiveUsers !== null && (
        <span
          className="wau-badge"
          title="Visszatérő (legalább 2x látott) egyedi látogatók az elmúlt 30 napban (admin nélkül)"
        >
          👥 <strong>{monthlyActiveUsers}</strong>
        </span>
      )}
    </div>

    {bugOpen && (
      <div className="bug-modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setBugOpen(false); }}>
        <div className="bug-modal" role="dialog" aria-modal="true" aria-label="Hibabejelentő">
          <div className="bug-modal-header">
            <span className="bug-modal-title">Visszajelzés / hibabejelentés</span>
            <button className="bug-modal-close" onClick={() => setBugOpen(false)} aria-label="Bezárás">✕</button>
          </div>
          <p className="bug-modal-info">
            Teljesen anoním, csak az üzenetet és az időt menti el.
          </p>
          <textarea
            className="bug-modal-textarea"
            rows={5}
            maxLength={2000}
            placeholder="Írd le a hibát, hiányzó funkciót, vagy bármilyen visszajelzést…"
            value={bugMessage}
            onChange={(e) => setBugMessage(e.target.value)}
            disabled={bugSending}
            autoFocus
          />
          <div className="bug-modal-footer">
            <span className="bug-modal-chars">{bugMessage.length}/2000</span>
            {bugStatus && <span className="bug-modal-status">{bugStatus}</span>}
            <button
              className="job-btn"
              onClick={handleBugSubmit}
              disabled={bugSending || !bugMessage.trim()}
            >
              {bugSending ? "Küldés…" : "Küldés"}
            </button>
          </div>
        </div>
      </div>
    )}
  </div>
);





};

export default JobWatcher;
