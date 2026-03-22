import React, { useEffect, useMemo, useState } from "react";
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
  "f"
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
  return hasJuniorYearToken(experience);
};

const isMediorExperience = (experience) => {
  if (isUnknownExperience(experience)) return true;
  return !hasJuniorYearToken(experience);
};

const getKeywordNotesForJob = (job) => {
  if (!job.title) return [];
  const title = job.title.toLowerCase();
  return Object.entries(JOB_KEYWORD_NOTES)
    .filter(([k]) => title.includes(k.toLowerCase()))
    .map(([, v]) => v);
};

const JobWatcher = () => {
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

      const internLike = INTERN_KEYWORDS.some((k) => t.includes(k));

      // Ha a forrás diákszövetkezet, akkor NE legyen junior/medior
      const isInternSource = JUNIOR_EXCLUDED_SOURCES.some((s) => source.includes(s));

      // Ha a cím tipikusan gyakornok/diák, akkor sem junior/medior
      const isInternTitle = INTERN_KEYWORDS.some((k) => title.includes(k));

      return !isInternSource && !isInternTitle && !internLike;
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
        const isInternSource = JUNIOR_EXCLUDED_SOURCES.some((s) => source.includes(s));
        const internLike = INTERN_KEYWORDS.some((k) => t.includes(k));
        return (
          (internLike && !t.includes(JUNIOR_KEYWORD)) || isInternSource
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

    return [...list].sort(
      (a, b) =>
        new Date(b.firstSeen || 0) - new Date(a.firstSeen || 0)
    );
  }, [jobs, q, time24h, time7d, internMode, juniorMode, mediorMode, sourceStates]);

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
            const state = sourceStates[s.key] || "neutral";
            let cls = "job-tab";
            if (state === "selected") cls += " active";
            if (state === "excluded") cls += " highlighted";

            return (
              <button
                key={s.key}
                className={cls}
                onClick={() => handleSourceClick(s.key)}
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
            job.firstSeen && hoursSince(job.firstSeen) <= 10;
          const notes = getKeywordNotesForJob(job);

          return (
            <li key={job.id} className="job-card">
              <div className="job-row">
                <a
                  className="job-title"
                  href={job.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {job.title}
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
