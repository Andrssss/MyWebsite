import React, { useEffect, useMemo, useState } from "react";
import "./JobWatcher.css";

const API_BASE_URL = "/.netlify/functions";

const hoursSince = (iso) => {
  const ms = Date.now() - new Date(iso).getTime();
  return ms / (1000 * 60 * 60);
};




const JobWatcher = () => {
  const [sources, setSources] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingSources, setLoadingSources] = useState(true);
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");


  const JOB_KEYWORD_NOTES = {
  "helpdesk": "Nem mérnöki munka. Rabszolga munka. Engedd el. Ő kezeli az IT jelszavakat és eszközöket.",
  "ServiceNOW": "Egy másikféle helpdesk. Jogosultságokat kezel, telepít szoftvereket. Ilyesmik.",

  "it gyakornok": "Általában ingyenmunkát jelent, ha ez a címe a poziciónak. Nem IT munka, ilyen szolgameló szokott lenni.",
  "business analyst": "Ő áll az IT és business között. A munkája nagy része a tervezés és szervezés. Kell tudni beszélni.",
  "system he": "Gyakran üzemeltetés + support keverék, nem feltétlen fejlesztés.",
  "IT üzemeltetési": "Ha egy software kész, az átkerűl az üzemeltetéshez.",
  "IT üzemeltető": "Ha egy software kész, az átkerűl az üzemeltetéshez.",

  "Manuális tesztelő": "Név jól leírja. Frontend, API, egyéb dolgokat tesztelnek. Nem IT munka. Nem kell hozzá nagy technikai tudás.",
  "Wordpress": "Nem IT munka. Ez inkább marketingeseknek lett kitalálva. Karrier semmiképp se lesz belőle. Kb. akkora redflag, mint amikor azt írják, h MS office ismeretek.",
  "Test engineer": "Ez izgi, fizetésben kicsit kevesebb, mint egy fejlesztői. De senior millióba bele tud kostólni és kevésbé stresszes. Ugyanúgy fejlesztői állás ez is. DB, API, OOP fontos hozzá.",
  "QA": "Tesztelés + gyakran automatizálás.",
  "DevOps": "Development + Operations. Általában ők csinálják a pipeline-okat. Menedzselik a repokat. Felhős környezeteket konfigurálnak. Mostanában nagy rá a kereslet. Jó cucc. Nem csak Docker, de kubernet is.",
  "UAT": "User Acceptance Testing (üzleti tesztelés).",
"L1": "helpdesk kezdőszíntje. Szar meló.",

};

const getKeywordNotesForJob = (job) => {
  if (!job.title) return [];

  const title = job.title.toLowerCase();
  const matches = [];

  for (const [keyword, note] of Object.entries(JOB_KEYWORD_NOTES)) {
    if (title.includes(keyword.toLowerCase())) {
      matches.push(note);
    }
  }

  return matches;
};




  // Three-state sources
  const [sourceStates, setSourceStates] = useState(() => {
    const saved = localStorage.getItem("jobWatcherSourceStates");
    return saved ? JSON.parse(saved) : {};
  });

  const [onlyNew, setOnlyNew] = useState(() => {
    const saved = localStorage.getItem("jobWatcherOnlyNew");
    return saved === "true";
  });

  // ----------------------
  const fetchSources = async () => {
    setLoadingSources(true);
    try {
      const res = await fetch(`${API_BASE_URL}/jobs/sources`);
      const txt = await res.text();
      if (!res.ok) throw new Error(txt || "Nem sikerült betölteni a forrásokat");
      const data = JSON.parse(txt);
      setSources(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error(e);
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
      if (!res.ok) {
        try {
          const errJson = JSON.parse(txt);
          throw new Error(errJson?.details || errJson?.error || txt);
        } catch {
          throw new Error(txt || "Hiba a betöltésnél.");
        }
      }
      const data = JSON.parse(txt);
      setJobs(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error(e);
      setStatus(`Hiba a betöltésnél: ${e.message}`);
      setJobs([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSources();
    fetchJobs();
  }, []);

  // ----------------------
  // Three-state toggle
  const handleSourceClick = (key) => {
    setSourceStates((prev) => {
      const current = prev[key] || "neutral"; // neutral, selected, excluded
      let next;
      if (current === "neutral") next = "selected";
      else if (current === "selected") next = "excluded";
      else next = "neutral";

      const newStates = { ...prev, [key]: next };
      localStorage.setItem("jobWatcherSourceStates", JSON.stringify(newStates));
      return newStates;
    });
  };




  // ----------------------
  const visibleJobs = useMemo(() => {
    let list = jobs;

    if (onlyNew) {
      list = list.filter((j) => j.firstSeen && hoursSince(j.firstSeen) <= 24);
    }

    const nq = q.trim().toLowerCase();
    if (nq) {
      list = list.filter((j) => {
        const t = String(j.title ?? "").toLowerCase();
        const d = String(j.description ?? "").toLowerCase();
        const notes = getKeywordNotesForJob(j).join(" ").toLowerCase();

        return t.includes(nq) || d.includes(nq) || notes.includes(nq);
      });
    }



    const selected = Object.keys(sourceStates).filter((k) => sourceStates[k] === "selected");
    const excluded = Object.keys(sourceStates).filter((k) => sourceStates[k] === "excluded");

    if (selected.length > 0) {
      list = list.filter((j) => selected.includes(j.source));
    } else if (excluded.length > 0) {
      list = list.filter((j) => !excluded.includes(j.source));
    }

    return [...list].sort((a, b) => {
      const ta = new Date(a.firstSeen || 0).getTime();
      const tb = new Date(b.firstSeen || 0).getTime();
      return tb - ta;
    });
  }, [jobs, onlyNew, q, sourceStates]);

  // ----------------------
  return (
    <div className="job-watcher">
      <div className="job-watcher-header">
        <div>
          <h1>Automata scraper</h1>
          <p>Minden nap UTC szerint 4 illetve 14-kor fut. Ekkor frissül.</p>
        </div>

        <div className="job-actions">
          <input
            className="job-search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Keresés cím/leírás alapján…"
          />

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

          <button
            className="job-btn"
            onClick={() => {
              fetchSources();
              fetchJobs();
            }}
            disabled={loading}
          >
            {loading ? "Betöltés…" : "Frissítés"}
          </button>
        </div>
      </div>

      <div className="job-tabs">
        {loadingSources ? (
          <div className="job-status">Források betöltése…</div>
        ) : (
          sources.map((s) => {
            const state = sourceStates[s.key] || "neutral";
            let className = "job-tab";
            if (state === "selected") className += " active";
            if (state === "excluded") className += " highlighted";

            return (
              <button
                key={s.key}
                className={className}
                onClick={() => handleSourceClick(s.key)}
                title={s.key}
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

      {status && <div className="job-status">{status}</div>}

      {loading ? (
        <div className="job-status">Betöltés…</div>
      ) : visibleJobs.length === 0 ? (
        <div className="job-status">Nincs találat.</div>
      ) : (
        <ul className="job-list">
          {visibleJobs.map((job) => {
              const isNew = job.firstSeen && hoursSince(job.firstSeen) <= 10;
              const keywordNotes = getKeywordNotesForJob(job);
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

                {job.description && <div className="job-desc">{job.description}</div>}
                {keywordNotes.length > 0 && (
                  <div className="job-note">
                    🧠 Kb. mit szokott ez a cím jelenteni:
                    <ul>
                      {keywordNotes.map((note, i) => (
                        <li key={i}>{note}</li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="job-meta">
                  {isNew && <span className="job-badge">Új</span>}
                  <span>
                    Első találat:{" "}
                    {job.firstSeen ? new Date(job.firstSeen).toLocaleString("hu-HU") : "—"}
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
