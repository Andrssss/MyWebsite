import React, { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { FaEnvelope, FaLinkedin } from "react-icons/fa";
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

const getOrCreateVisitorId = () => {
  const existing = readCookie(VISITOR_COOKIE_NAME);
  if (existing) return existing;
  const nextId = createVisitorId();
  writeCookie(VISITOR_COOKIE_NAME, nextId, 365 * 2);
  return nextId;
};

const VISITOR_CLICK_API = "/.netlify/functions/visitor-click";

const CLICKED_KEYS_STORAGE = "jobWatcherClickedKeys";
const APPLIED_KEYS_STORAGE = "jobWatcherAppliedKeys";
const IMPORT_ID_STORAGE = "jobWatcherImportId";

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

const APPLIED_CACHE_STORAGE = "jobWatcherAppliedCache";

const SYNC_API = "/.netlify/functions/sync-data";
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

const JUNIOR_EXCLUDED_SOURCES = [
  "minddiak",
  "muisz",
  "zyntern",
  "schonherz",
  "prodiak",
  "tudasdiak",
  "vizmuvek",
  "tudatosdiak",
  "ydiak",
  "qdiak"
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
  if (effective.length > 1 && effective.includes("Hálózat / Infra")) {
    const others = effective.filter((c) => c !== "Hálózat / Infra");
    return others;
  }
  // Mérnöki / Gyártás alacsony prioritású (de Fejlesztőnél erősebb): ha más nem-Fejlesztő is matchelt, az nyerjen
  if (effective.length > 1 && effective.includes("Mérnöki / Gyártás")) {
    const others = effective.filter((c) => c !== "Mérnöki / Gyártás");
    return others;
  }
  return effective;
};

const JobWatcher = () => {
  const navigate = useNavigate();
  const debugMode = new URLSearchParams(window.location.search).has("debug");
  const [sources, setSources] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingSources, setLoadingSources] = useState(true);
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
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

  const [time24h, setTime24h] = useState(() => {
    const saved = localStorage.getItem("jobWatcherTime24h");
    return saved === null ? true : saved === "true";
  });
  const [time7d, setTime7d] = useState(() => {
    const saved = localStorage.getItem("jobWatcherTime7d");
    return saved === null ? false : saved === "true";
  });

  const [sourcesOpen, setSourcesOpen] = useState(() => {
    const saved = localStorage.getItem("jobWatcherSourcesOpen");
    return saved !== null ? saved === "true" : true;
  });

  const [categoryStates, setCategoryStates] = useState(() => {
    const saved = localStorage.getItem("jobWatcherCategoryStates");
    return saved ? JSON.parse(saved) : {};
  });

  const [categoriesOpen, setCategoriesOpen] = useState(() => {
    const saved = localStorage.getItem("jobWatcherCategoriesOpen");
    return saved !== null ? saved === "true" : true;
  });

  const [clickedKeys, setClickedKeys] = useState(() => loadClickedKeys());
  const [appliedKeys, setAppliedKeys] = useState(() => loadAppliedKeys());
  const [appliedCache, setAppliedCache] = useState(() => loadAppliedCache());
  const [showAppliedOnly, setShowAppliedOnly] = useState(false);

  const [manualAppliedTitle, setManualAppliedTitle] = useState("");
  const [manualAppliedSource, setManualAppliedSource] = useState("");
  const [manualAppliedUrl, setManualAppliedUrl] = useState("");
  const [manualAppliedDate, setManualAppliedDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [manualAppliedExperience, setManualAppliedExperience] = useState("");
  const [manualAppliedStatus, setManualAppliedStatus] = useState("");
  const [manualAddOpen, setManualAddOpen] = useState(false);

  const [syncOpen, setSyncOpen] = useState(false);
  const [syncIdShown, setSyncIdShown] = useState(false);
  const [syncStatus, setSyncStatus] = useState("");
  const [importId, setImportId] = useState(
    () => localStorage.getItem(IMPORT_ID_STORAGE) || ""
  );
  const myVisitorId = useMemo(() => getOrCreateVisitorId(), []);
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

  const handleSyncUpload = async () => {
    setSyncStatus("Feltöltés…");
    try {
      const data = {
        clicked: [...loadClickedKeys()],
        applied: [...loadAppliedKeys()],
        appliedCache: loadAppliedCache(),
      };
      const res = await fetch(SYNC_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visitorId: myVisitorId, data }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const respJson = await res.json();
      setSyncStatus(`✔ Feltöltve (${respJson.counts.clicked} megtekintve, ${respJson.counts.applied} jelentkezés)`);
    } catch {
      setSyncStatus("✗ Hiba a feltöltés során");
    }
  };

  const handleSyncDownload = async () => {
    const id = importId.trim();
    if (!id) {
      setSyncStatus("Adj meg egy szinkron ID-t");
      return;
    }
    setSyncStatus("Letöltés…");
    try {
      const res = await fetch(`${SYNC_API}?visitorId=${encodeURIComponent(id)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { data } = await res.json();
      if (!data) {
        setSyncStatus("✗ Nincs ilyen szinkron ID-hez tartozó adat");
        return;
      }
      const mergedClicked = new Set([...loadClickedKeys(), ...(data.clicked || [])]);
      const mergedApplied = new Set([...loadAppliedKeys(), ...(data.applied || [])]);
      const mergedCache = { ...loadAppliedCache(), ...(data.appliedCache || {}) };
      localStorage.setItem(CLICKED_KEYS_STORAGE, JSON.stringify([...mergedClicked].slice(-500)));
      localStorage.setItem(APPLIED_KEYS_STORAGE, JSON.stringify([...mergedApplied]));
      localStorage.setItem(APPLIED_CACHE_STORAGE, JSON.stringify(mergedCache));
      setClickedKeys(mergedClicked);
      setAppliedKeys(mergedApplied);
      setAppliedCache(mergedCache);
      setSyncStatus(`✔ Importálva (${data.clicked?.length || 0} megtekintve, ${data.applied?.length || 0} jelentkezés)`);
    } catch {
      setSyncStatus("✗ Hiba a letöltés során");
    }
  };

  const handleCopySyncId = async () => {
    try {
      await navigator.clipboard.writeText(myVisitorId);
      setSyncStatus("✔ ID másolva");
    } catch {
      setSyncStatus("✗ Másolás nem sikerült");
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
      } else {
        next.add(key);
        if (job) {
          setAppliedCache((c) => {
            const updated = { ...c, [key]: job };
            saveAppliedCache(updated);
            return updated;
          });
        }
      }
      saveAppliedKeys(next);
      return next;
    });
  };

  const handleAddManualApplied = () => {
    const title = manualAppliedTitle.trim();
    const source = manualAppliedSource.trim() || "manual";
    const url = manualAppliedUrl.trim();
    if (!title) { setManualAppliedStatus("Adj meg legalább egy pozíció nevet"); return; }
    const key = `job:${source}:${title}`;
    const firstSeen = manualAppliedDate && /^\d{4}-\d{2}-\d{2}$/.test(manualAppliedDate)
      ? new Date(manualAppliedDate + "T00:00:00").toISOString()
      : new Date().toISOString();
    const manualJob = { source, title, url, firstSeen, experience: manualAppliedExperience.trim() || undefined };
    setAppliedKeys((prev) => { const next = new Set(prev); next.add(key); saveAppliedKeys(next); return next; });
    setAppliedCache((prev) => { const updated = { ...prev, [key]: manualJob }; saveAppliedCache(updated); return updated; });
    setManualAppliedTitle("");
    setManualAppliedSource("");
    setManualAppliedUrl("");
    setManualAppliedDate(new Date().toISOString().slice(0, 10));
    setManualAppliedExperience("");
    setManualAppliedStatus("Hozzáadva");
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
  const [commitsOpen, setCommitsOpen] = useState(false);
  const [showEmail, setShowEmail] = useState(false);
  const [weeklyActiveUsers, setWeeklyActiveUsers] = useState(null);

  useEffect(() => {
    fetch(VISITOR_TRACK_API)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data && typeof data.wau === "number") setWeeklyActiveUsers(data.wau);
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
    fetch("/.netlify/functions/last-commit")
      .then((r) => r.json())
      .then((data) => {
        if (!Array.isArray(data?.updates)) return;
        setLastUpdates(
          data.updates
            .filter((u) => u?.message && u?.date)
            .map((u) => ({
              message: u.message,
              date: new Date(u.date),
            }))
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

  const fetchJobs = async (next24h = time24h, next7d = time7d, force = false) => {
    let effectiveRange = null;
    if (next24h && next7d) effectiveRange = "30d";
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
  }, []);

  useEffect(() => {
    fetchJobs(time24h, time7d);
  }, [time24h, time7d]);

  const toggleSources = () => {
    setSourcesOpen((prev) => {
      localStorage.setItem("jobWatcherSourcesOpen", !prev);
      return !prev;
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

  const handleInternToggle = (checked) => {
    setInternMode(checked);
    localStorage.setItem("jobWatcherInternMode", checked);
    if (checked) {
      setJuniorMode(false);
      localStorage.setItem("jobWatcherJuniorMode", false);
      setMediorMode(false);
      localStorage.setItem("jobWatcherMediorMode", false);
    }
  };

  const handleJuniorToggle = (checked) => {
    setJuniorMode(checked);
    localStorage.setItem("jobWatcherJuniorMode", checked);
    if (checked) {
      setInternMode(false);
      localStorage.setItem("jobWatcherInternMode", false);
    }
  };

  const handleMediorToggle = (checked) => {
    setMediorMode(checked);
    localStorage.setItem("jobWatcherMediorMode", checked);
    if (checked) {
      setInternMode(false);
      localStorage.setItem("jobWatcherInternMode", false);
    }
  };

  /* =======================
     SZŰRT LISTA
  ======================= */
  const visibleJobs = useMemo(() => {
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

      return !isInternSource && !isInternTitle && !internLike && !isInternExp;
    };

    if (time24h && !time7d) {
      list = list.filter((j) => j.firstSeen && hoursSince(j.firstSeen) <= 24);
    } else if (time7d) {
      list = list.filter((j) => j.firstSeen && hoursSince(j.firstSeen) <= 24 * 7);
    }

    const nq = q.trim().toLowerCase();
    if (nq) {
      list = list.filter((j) => {
        const t = (j.title || "").toLowerCase();
        return t.includes(nq);
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

        // Ha medior szót tartalmaz, CSAK medior szűrővel jelenjen meg
        if (mediorInText) {
          return mediorMode;
        }

        // Egyébként a szokásos junior/medior logika
        const matchesJunior = juniorMode && isJuniorExperience(j.experience);
        const matchesMedior = mediorMode && isMediorExperience(j.experience);
        return matchesJunior || matchesMedior;
      });
    }

    const selected = Object.keys(sourceStates).filter(
      (k) => sourceStates[k] === "selected"
    );
    const excluded = Object.keys(sourceStates).filter(
      (k) => sourceStates[k] === "excluded"
    );

    if (selected.length) {
      list = list.filter((j) => selected.includes(j.source));
    } else if (excluded.length) {
      list = list.filter((j) => !excluded.includes(j.source));
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

    if (showAppliedOnly) {
      const cachedJobs = Object.values(appliedCache);
      const apiKeys = new Set(list.map((j) => `job:${j.source}:${j.title}`));
      const onlyCached = cachedJobs.filter((j) => !apiKeys.has(`job:${j.source}:${j.title}`) && appliedKeys.has(`job:${j.source}:${j.title}`));
      list = [...list.filter((j) => appliedKeys.has(`job:${j.source}:${j.title}`)), ...onlyCached];
    }

    return [...list].sort(
      (a, b) =>
        new Date(b.firstSeen || 0) - new Date(a.firstSeen || 0)
    );
  }, [jobs, q, time24h, time7d, internMode, juniorMode, mediorMode, sourceStates, categoryStates, jobCategories, showAppliedOnly, appliedKeys, appliedCache]);

  const activeTimeLabel = time7d
    ? "1 hét"
    : time24h
    ? "24h"
    : "nincs";

  /* =======================
     RENDER
  ======================= */
  return (
  <div className="job-watcher">
    <div className="job-watcher-header">
      <div>
          <h1>Automata scraper</h1>
          <p>Minden nap UTC szerint 5-22 között óránként frissül. Kivéve ami nem, mivel nèha kedve tàmad, a folyamatos fejlesztès miatt. Szólj, ha vmit szeretnèl itt látni.</p>
          <div className="job-last-commit">
            <span>Elmúlt 1 hét git commitok:</span>
            {lastUpdates.length > 0 ? (
              <>
                <ul>
                  {lastUpdates.slice(0, 3).map((u, i) => (
                    <li key={`${u.date.toISOString()}-${i}`}>
                      {`${u.message} - ${u.date.toLocaleString("hu-HU", { dateStyle: "short", timeStyle: "short" })}`}
                    </li>
                  ))}
                </ul>
                {lastUpdates.length > 3 && (
                  <>
                    <button
                      className="job-commits-toggle"
                      onClick={() => setCommitsOpen((prev) => !prev)}
                    >
                      {commitsOpen
                        ? "▲ Régebbiek elrejtése"
                        : `▼ Még ${lastUpdates.length - 3} commit megjelenítése`}
                    </button>
                    {commitsOpen && (
                      <ul>
                        {lastUpdates.slice(3).map((u, i) => (
                          <li key={`${u.date.toISOString()}-${i + 3}`}>
                            {`${u.message} - ${u.date.toLocaleString("hu-HU", { dateStyle: "short", timeStyle: "short" })}`}
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
              </>
            ) : (
              <div>Nincs frissítés az elmúlt 7 napban.</div>
            )}
          </div>
      </div>

      <div className="job-actions">
        <input
          className="job-search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Keresés…"
        />

        <div className="job-filters">
          <label className="job-checkbox">
            <input
              type="checkbox"
              checked={internMode}
              onChange={(e) => handleInternToggle(e.target.checked)}
            />
            Csak gyakornok
          </label>

          <label className="job-checkbox">
            <input
              type="checkbox"
              checked={juniorMode}
              onChange={(e) => handleJuniorToggle(e.target.checked)}
            />
            Csak junior
          </label>

          <label className="job-checkbox">
            <input
              type="checkbox"
              checked={mediorMode}
              onChange={(e) => handleMediorToggle(e.target.checked)}
            />
            Csak medior
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
                }
              }}
            />
            Csak új (24h)
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
                }
              }}
            />
            Csak új (1 hét)
          </label>
        </div>

        <div className="job-action-btns">
          <button
            className={`job-btn job-btn--toggle${showAppliedOnly ? " active" : ""}`}
            onClick={() => setShowAppliedOnly((v) => !v)}
          >
            {showAppliedOnly ? `✓ Jelentkezések (${appliedKeys.size})` : `Jelentkezések (${appliedKeys.size})`}
          </button>
          <button className="job-btn job-btn-stats" onClick={() => navigate("/allasfigyelo/stats")}>
            📊 Statisztikák 📊
          </button>
          <button className="job-btn" onClick={() => fetchJobs(time24h, time7d, true)}>
            Frissítés
          </button>
        </div>
      </div>
    </div>

    {/* ===== ESZKÖZÖK KÖZÖTTI SZINKRON ===== */}
    <div className="job-sync">
      <button
        className="job-tabs-toggle"
        onClick={() => setSyncOpen((v) => !v)}
      >
        {syncOpen ? "▲ Szinkron elrejtése" : "🔄 Szinkron eszközök között"}
      </button>
      {syncOpen && (
        <div className="job-sync-panel">
          <div className="job-sync-section">
            <strong>A te szinkron ID-d:</strong>
            <code className="job-sync-id">
              {syncIdShown ? myVisitorId : "•••••••• (rejtett)"}
            </code>
            <button className="job-btn job-btn--toggle" onClick={() => setSyncIdShown((v) => !v)}>
              {syncIdShown ? "Elrejtés" : "Mutatás"}
            </button>
            <button className="job-btn job-btn--toggle" onClick={handleCopySyncId}>📋 Másolás</button>
            <button className="job-btn job-btn-stats" onClick={handleSyncUpload}>
              ⬆ Feltöltés
            </button>
          </div>
          <div className="job-sync-section">
            <strong>Importálás másik eszközről:</strong>
            <input
              className="job-search"
              placeholder="Másik eszköz szinkron ID-ja"
              value={importId}
              onChange={(e) => {
                const nextValue = e.target.value;
                setImportId(nextValue);
                localStorage.setItem(IMPORT_ID_STORAGE, nextValue);
              }}
            />
            <button className="job-btn" onClick={handleSyncDownload}>
              ⬇ Letöltés és összefésülés
            </button>
          </div>
          {syncStatus && <div className="job-sync-status">{syncStatus}</div>}
          <p className="job-sync-help">
            ⚠️ Az ID-t senkinek ne add ki — aki ismeri, le tudja tölteni a megnézett és jelentkezett állásaid listáját.
            Az importálás összefésüli az adatokat a meglevőkkel (nem felülírja).
          </p>
        </div>
      )}
    </div>

    {/* ===== FORRÁS TAB TOGGLE ===== */}
    <div className="job-tabs-header">
      <button
        className="job-tabs-toggle"
        onClick={toggleSources}
      >
        {sourcesOpen ? "▲ Források elrejtése" : "▼ Források kiválasztása"}
      </button>
    </div>

    {/* ===== FORRÁS TABOK ===== */}
    <div className={`job-tabs-wrapper ${sourcesOpen ? "open" : ""}`}>
      <div className="job-tabs">
        {loadingSources ? (
          <div className="job-status">Források betöltése…</div>
        ) : (
          sources.map((s) => {
            const state = sourceStates[s.source] || "neutral";
            let cls = "job-tab";
            if (state === "selected") cls += " active";
            if (state === "excluded") cls += " highlighted";

            return (
              <button
                key={s.source}
                className={cls}
                onClick={() => handleSourceClick(s.source)}
              >
                {s.label}
                {typeof s.count === "number" && (
                  <span className="job-tab-count">{s.count}</span>
                )}
              </button>
            );
          })
        )}
      </div>
      </div>

    {/* ===== KATEGÓRIÁK ===== */}
    <div className="job-tabs-header">
      <button
        className="job-tabs-toggle"
        onClick={() =>
          setCategoriesOpen((prev) => {
            localStorage.setItem("jobWatcherCategoriesOpen", !prev);
            return !prev;
          })
        }
      >
        {categoriesOpen ? "▲ Kategóriák elrejtése" : "▼ Kategóriák kiválasztása"}
      </button>
    </div>

    <div className={`job-tabs-wrapper ${categoriesOpen ? "open" : ""}`}>
      <div className="job-tabs">
        {jobCategories.map(([cat]) => cat).concat("Egyéb").map((cat) => {
          const state = categoryStates[cat] || "neutral";
          let cls = "job-tab";
          if (state === "selected") cls += " active";
          if (state === "excluded") cls += " highlighted";
          return (
            <button key={cat} className={cls} onClick={() => handleCategoryClick(cat)}>
              {cat}
              <span className="job-tab-count">{categoryCounts[cat]}</span>
            </button>
          );
        })}
      </div>
    </div>

    {/* ===== TALÁLATOK ===== */}
    {!loading && (
      <div className="job-status">
        Aktív időszűrő: {activeTimeLabel} · Találatok: {visibleJobs.length}
      </div>
    )}

    {loading ? (
      <div className="job-status">Betöltés…</div>
    ) : visibleJobs.length === 0 && !showAppliedOnly ? (
      <div className="job-status">Nincs találat.</div>
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
          const isVisited = clickedKeys.has(clickKeyBase);
          const isApplied = appliedKeys.has(clickKeyBase);

          return (
            <li key={rowKey} className={`job-card${isVisited ? " job-card--visited" : ""}${isApplied ? " job-card--applied" : ""}${job.isCrossDuplicate ? " job-card--crossdup" : ""}`}>
              <div className="job-row">
                <div className="job-title-group">
                  <a
                    className="job-title"
                    href={job.source === "minddiak" ? "https://minddiak.hu/diakmunka/work_type/10" : job.url}
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
                    <span className="job-company">[{job.company}]</span>
                  )}
                </div>
                <span className="job-source">{job.source}</span>
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
                {job.isCrossDuplicate && (
                  <span className="job-badge job-badge--crossdup" title="Ugyanez a cím és cég más forrásban is megjelent">
                    Dupla
                  </span>
                )}
                {job.experience && (
                  <span className="job-experience">{job.experience}</span>
                )}
                <span>
                  {job.firstSeen
                    ? new Date(job.firstSeen).toLocaleString("hu-HU")
                    : "—"}
                </span>
                {(isVisited || isApplied) && (
                  <button
                    className={`job-applied-btn${isApplied ? " applied" : ""}`}
                    onClick={() => toggleApplied(clickKeyBase, job)}
                    title={isApplied ? "Jelentkezés visszavonása" : "Megjelölés: Jelentkeztem"}
                  >
                    {isApplied ? "✓ Jelentkeztem" : "Jelentkeztem?"}
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
            className={`job-card job-card--manual-add${manualAddOpen ? " open" : ""}`}
            onClick={!manualAddOpen ? () => { setManualAddOpen(true); setManualAppliedStatus(""); } : undefined}
          >
            <span className="job-card-fold" aria-hidden="true" />
            <button
              type="button"
              className="job-manual-toggle"
              onClick={(e) => {
                e.stopPropagation();
                setManualAddOpen((v) => !v);
                setManualAppliedStatus("");
              }}
            >
              <span className="job-manual-cta">
                <strong>Kézileg hozzáadott jelentkezés</strong>
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
                    onChange={(e) => setManualAppliedUrl(e.target.value)}
                    placeholder="Link (opcionális)"
                  />
                  <input
                    className="job-search"
                    value={manualAppliedExperience}
                    onChange={(e) => setManualAppliedExperience(e.target.value)}
                    placeholder="Tapasztalat szint (opcionális)"
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
                  <span style={{ color: manualAppliedStatus === "Hozzáadva" ? "#4ade80" : "#ef4444" }}>{manualAppliedStatus}</span>
                  <button className="job-btn" onClick={handleAddManualApplied}>Hozzáadás</button>
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

      <button
        className="bug-icon-btn"
        onClick={() => { setBugOpen(true); setBugStatus(""); }}
        title="Visszajelzés / hibabejelentés"
        aria-label="Visszajelzés küldése"
      >
        🐛
      </button>

      {weeklyActiveUsers !== null && (
        <span
          className="wau-badge"
          title="Egyedi látogatók az elmúlt 7 napban (admin nélkül)"
        >
          👥 <strong>{weeklyActiveUsers}</strong>
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
