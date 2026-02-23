import React, { useEffect, useMemo, useState } from "react";
import "./JobWatcher.css";

const API_BASE_URL = "/.netlify/functions";

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
  "cvcentrum",
  "zyntern",
  "schonherz",
  "prodiak",
  "tudasdiak",
  "otp",
  "vizmuvek",
  "tudatosdiak",
  "onejob"
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

  const [onlyNew, setOnlyNew] = useState(
    () => localStorage.getItem("jobWatcherOnlyNew") === "true"
  );

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

  const fetchJobs = async () => {
    setLoading(true);
    setStatus("");
    try {
      const res = await fetch(`${API_BASE_URL}/jobs?limit=500`);
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
    fetchJobs();
  }, []);

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

  /* =======================
     SZŰRT LISTA
  ======================= */
  const visibleJobs = useMemo(() => {
    let list = jobs;

    if (onlyNew) {
      list = list.filter((j) => j.firstSeen && hoursSince(j.firstSeen) <= 24);
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
        const isInternSource = JUNIOR_EXCLUDED_SOURCES.some((s) => source.includes(s) );
        const internLike = INTERN_KEYWORDS.some((k) => t.includes(k)); 

        return (
          (internLike && !t.includes(JUNIOR_KEYWORD)) || isInternSource
        );
      });
    }

    if (juniorMode) {
      list = list.filter((j) => {
        const t = (j.title || "").toLowerCase();
        const title = (j.title || "").toLowerCase();
        const source = (j.source || "").toLowerCase();

        const internLike = INTERN_KEYWORDS.some((k) => t.includes(k)); 

        // Ha a forrás diákszövetkezet, akkor NE legyen junior
        const isInternSource = JUNIOR_EXCLUDED_SOURCES.some((s) => source.includes(s) );

        // Ha a cím tipikusan gyakornok/diák, akkor sem junior
        const isInternTitle = INTERN_KEYWORDS.some((k) => title.includes(k) );

        return !isInternSource && !isInternTitle && !internLike;
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
  }, [jobs, q, onlyNew, internMode, juniorMode, sourceStates]);

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
            checked={onlyNew}
            onChange={(e) => {
              setOnlyNew(e.target.checked);
              localStorage.setItem("jobWatcherOnlyNew", e.target.checked);
            }}
          />
          Csak új (24h)
        </label>

        <button className="job-btn" onClick={fetchJobs}>
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
