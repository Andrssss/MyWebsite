import React, { useEffect, useMemo, useState } from "react";
import "./JobWatcher.css";

const API_BASE_URL = "/.netlify/functions";

const hoursSince = (iso) => {
  const ms = Date.now() - new Date(iso).getTime();
  return ms / (1000 * 60 * 60);
};

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
];

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
    "Frontend/API tesztelés, kevés technikai mélység.",
  Wordpress:
    "Inkább marketing irány, nem klasszikus IT karrier.",
  "Test engineer":
    "Automatizált tesztelés, DB, API, OOP fontos.",
  QA: "Tesztelés + automatizálás.",
  DevOps:
    "Pipeline, cloud, infra. Nagy kereslet, jó irány.",
  UAT: "User Acceptance Testing.",
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

  const [internMode, setInternMode] = useState(
    () => localStorage.getItem("jobWatcherInternMode") === "true"
  );

  const [juniorMode, setJuniorMode] = useState(
    () => localStorage.getItem("jobWatcherJuniorMode") === "true"
  );

  const [onlyNew, setOnlyNew] = useState(
    () => localStorage.getItem("jobWatcherOnlyNew") === "true"
  );

  const fetchSources = async () => {
    setLoadingSources(true);
    try {
      const res = await fetch(`${API_BASE_URL}/jobs/sources`);
      const data = await res.json();
      setSources(Array.isArray(data) ? data : []);
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
      const data = await res.json();
      setJobs(Array.isArray(data) ? data : []);
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

  const visibleJobs = useMemo(() => {
    let list = jobs;

    if (onlyNew) {
      list = list.filter((j) => j.firstSeen && hoursSince(j.firstSeen) <= 24);
    }

    const nq = q.trim().toLowerCase();
    if (nq) {
      list = list.filter((j) => {
        const t = (j.title || "").toLowerCase();
        const d = (j.description || "").toLowerCase();
        const notes = getKeywordNotesForJob(j).join(" ").toLowerCase();
        return t.includes(nq) || d.includes(nq) || notes.includes(nq);
      });
    }

    if (internMode) {
      list = list.filter((j) => {
        const title = (j.title || "").toLowerCase();
        return (
          INTERN_KEYWORDS.some((k) => title.includes(k)) &&
          !title.includes(JUNIOR_KEYWORD)
        );
      });
    }

    if (juniorMode) {
      list = list.filter((j) => {
        const title = (j.title || "").toLowerCase();
        const source = (j.source || "").toLowerCase();

        // Ha a forrás diákszövetkezet, akkor NE legyen junior
        const isInternSource = JUNIOR_EXCLUDED_SOURCES.some((s) =>
          source.includes(s)
        );

        // Ha a cím tipikusan gyakornok/diák, akkor sem junior
        const isInternTitle = INTERN_KEYWORDS.some((k) => title.includes(k));

        return !isInternSource && !isInternTitle;
      });
    }




    return [...list].sort(
      (a, b) =>
        new Date(b.firstSeen || 0).getTime() -
        new Date(a.firstSeen || 0).getTime()
    );
  }, [jobs, onlyNew, q, internMode, juniorMode]);

  return (
    <div className="job-watcher">
      <div className="job-watcher-header">
        <div>
          <h1>Automata scraper</h1>
          <p>Minden nap UTC szerint 4 és 14 órakor frissül. De még van ami csak manuális futtatásra mükszik, mert cloud IP le van tiltva</p>
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

                {job.description && (
                  <div className="job-desc">{job.description}</div>
                )}

                {keywordNotes.length > 0 && (
                  <div className="job-note">
                    💭 Megjegyzés:
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
