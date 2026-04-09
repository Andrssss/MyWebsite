import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import "./JobWatcher.css";

const API_BASE_URL = "/.netlify/functions";
const TIME_RANGE_24H = "24h";
const TIME_RANGE_7D = "7d";

const hoursSince = (iso) => {
  const ms = Date.now() - new Date(iso).getTime();
  return ms / (1000 * 60 * 60);
};

/* =======================
   INTERN / JUNIOR LOGIKA
======================= */
const INTERN_KEYWORDS = ["intern", "gyakornok", "trainee", "diák", "diákmunka"];
const JUNIOR_KEYWORD = "junior";

const JUNIOR_EXCLUDED_SOURCES = [
  "minddiak",
  "muisz",
  "zyntern",
  "schonherz",
  "prodiak",
  "tudasdiak",
  "otp",
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
   KATEGÓRIÁK
   Specifikusabb ELŐRE, általános ("Fejlesztő") HÁTRA.
   Egy job csak 1 kategóriába kerül (az első illeszkedő).
======================= */
const JOB_CATEGORIES = [
  ["Webfejlesztés", ["Webmaster","Alkalmazásfejlesztő","frontend", "front-end", "front end", "backend", "back-end", "back end", "full stack", "fullstack", "full-stack", "react", "angular", "vue", "node.js", "nodejs", "web developer", "webfejlesztő", "web fejlesztő", "php", "django", "laravel", "next.js", "nuxt", "svelte", "typescript", "ui", "ux", "ui/ux", "ux/ui", "ui designer", "ux designer", "ux engineer", "user interface", "user experience", "figma", "design system", "interaction design", "product designer", "web design", "webdesign"]],
  ["Data / AI", ["ai automation","AI mérnök","copilot","ai prompt","conversation ai","ai applications","ai project","ai fejleszto","gen ai", "data engineer", "data scientist", "data science", "machine learning", "big data", "ai engineer", "ai developer", "artificial intelligence", "deep learning","adatbázis", "database" ,"nlp", "computer vision", "llm", "ml engineer", "ml ops", "mlops", "data platform", "generative ai"]],
  ["DevOps", ["AWS","Azure","cloud architect","devops", "sre", "site reliability", "cloud engineer", "platform engineer", "kubernetes", "docker", "terraform", "ci/cd", "cicd"]],
  ["QA / Tesztelő", ["tesztautomatizalo","testing","testing specialist","Tesztautomatizálási","automata tesztelo","fat","Tesztautomatizáló","Tesztautomatizálás","tesztmérnök","tesztelo","tester", "tesztelő", "qa", "quality assurance", "test engineer", "test automation", "automation engineer", "selenium"]],
  ["Helpdesk", ["helpdesk", "help desk", "service desk", "servicenow", "it support", "it technikus"]],
  ["Elemző", ["analyst","elemzési", "elemző", "elemzo", "analist", "analytics", "business analyst", "data analyst", "business intelligence", "bi developer", "bi specialist", "reporting", "riport", "power bi", "tableau"]],
  ["SAP", ["sap", "abap", "s/4hana", "s4hana", "sap hana", "sap basis", "sap fiori", "sap tanácsadó", "sap konzultáns", "sap consultant", "sap fejlesztő", "sap developer", "sap admin", "sap rendszergazda", "sap üzemeltető", "successfactors", "ariba", "concur"]],
  ["Security", ["IT Biztonságtechnikai","safety","security","biztonsági","Információbiztonsági", "Kiberbiztonsági","cybersecurity", "infosec", "penetration", "soc analyst", "security engineer"]],
  ["Hálózat / Infra", ["network", "hálózat", "infrastructure", "system admin", "rendszermérnök", "sysadmin", "linux admin", "windows admin", "it üzemeltető", "üzemeltetés"]],
  ["Hardware", ["karbantartási","eszközcserét","hardware", "embedded", "hw", "fpga", "pcb", "firmware"]],
  ["Mobil", ["android", "ios", "mobile developer", "flutter", "react native", "swift", "kotlin"]],
  ["Fejlesztő", ["C++","automation","autómatizálási","python", "java","software development","developer", "fejlesztő","fejlesztés","development", "fejleszto", "programozó", "software engineer", "engineer"]],
];

const getCategoriesForJob = (job) => {
  if (!job.title) return [];
  const title = job.title.toLowerCase();
  const match = JOB_CATEGORIES.find(([, kws]) => kws.some((kw) => title.includes(kw.toLowerCase())));
  return match ? [match[0]] : [];
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

  const [lastUpdates, setLastUpdates] = useState([]);
  const [commitsOpen, setCommitsOpen] = useState(false);

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

  const fetchJobs = async (next24h = time24h, next7d = time7d) => {
    setLoading(true);
    setStatus("");
    try {
      const params = new URLSearchParams({ limit: "5000" });

      let effectiveRange = null;
      if (next7d) effectiveRange = TIME_RANGE_7D;
      else if (next24h) effectiveRange = TIME_RANGE_24H;

      if (effectiveRange) {
        params.set("timeRange", effectiveRange);
      }

      const res = await fetch(`${API_BASE_URL}/jobs?${params.toString()}`);
      const txt = await res.text();
      if (!res.ok) throw new Error(txt);
      setJobs(JSON.parse(txt) || []);
    } catch (e) {
      setStatus(`Hiba: ${e.message}`);
      setJobs([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSources();
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
    for (const [cat] of JOB_CATEGORIES) counts[cat] = 0;
    counts["Egyéb"] = 0;
    for (const job of jobs) {
      const cats = getCategoriesForJob(job);
      if (cats.length === 0) {
        counts["Egyéb"]++;
      } else {
        for (const cat of cats) counts[cat]++;
      }
    }
    return counts;
  }, [jobs]);


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
        const cats = getCategoriesForJob(j);
        if (cats.length === 0) return selectedCats.includes("Egyéb");
        return cats.some((c) => selectedCats.includes(c));
      });
    } else if (excludedCats.length) {
      list = list.filter((j) => {
        const cats = getCategoriesForJob(j);
        if (cats.length === 0) return !excludedCats.includes("Egyéb");
        return !cats.some((c) => excludedCats.includes(c));
      });
    }

    return [...list].sort(
      (a, b) =>
        new Date(b.firstSeen || 0) - new Date(a.firstSeen || 0)
    );
  }, [jobs, q, time24h, time7d, internMode, juniorMode, mediorMode, sourceStates, categoryStates]);

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
          <p>Minden nap UTC szerint 4-23 között óránként frissül. Kivéve ami nem, mivel nèha kedve tàmad, a folyamatos fejlesztès miatt. Szólj, ha vmit szeretnèl itt látni.</p>
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
            }}
          />
          Csak új (1 hét)
        </label>

        <button className="job-btn job-btn-stats" onClick={() => navigate("/allasfigyelo/stats")}>
          📊 Statisztikák 📊
        </button>
        <button className="job-btn" onClick={() => fetchJobs(time24h, time7d)}>
          Frissítés
        </button>
      </div>
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
        {JOB_CATEGORIES.map(([cat]) => cat).concat("Egyéb").map((cat) => {
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
    ) : visibleJobs.length === 0 ? (
      <div className="job-status">Nincs találat.</div>
    ) : (
      <ul className="job-list">
        {visibleJobs.map((job) => {
          const isNew =
            job.firstSeen && hoursSince(job.firstSeen) <= 1;
          const notes = getKeywordNotesForJob(job);
          const rowKey = `${job.source || "src"}-${job.url || job.title}-${job.firstSeen || "ts"}`;

          return (
            <li key={rowKey} className="job-card">
              <div className="job-row">
                <a
                  className="job-title"
                  href={job.source === "minddiak" ? "https://minddiak.hu/diakmunka/work_type/10" : job.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {job.title}
                  {debugMode && (
                    <span style={{ color: "#f50b0b", marginLeft: 6, fontSize: "0.85em" }}>
                      [{getCategoriesForJob(job).join(", ") || "Egyéb"}]
                    </span>
                  )}
                </a>
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
                {job.experience && (
                  <span className="job-experience">{job.experience}</span>
                )}
                <span>
                  {job.firstSeen
                    ? new Date(job.firstSeen).toLocaleString("hu-HU")
                    : "—"}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    )}
  </div>
);





};

export default JobWatcher;
