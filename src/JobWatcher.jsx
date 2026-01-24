import React, { useEffect, useMemo, useState } from "react";
import "./JobWatcher.css";

const API_BASE_URL = "/.netlify/functions";

const SOURCES = [
  { key: "melodiak", label: "melodiak.hu" },
  { key: "minddiak", label: "minddiak.hu" },
  { key: "muisz", label: "muisz.hu" },
  { key: "all", label: "Összes" },
];

const hoursSince = (iso) => {
  const ms = Date.now() - new Date(iso).getTime();
  return ms / (1000 * 60 * 60);
};

const JobWatcher = () => {
  const [activeSource, setActiveSource] = useState("melodiak");
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [onlyNew, setOnlyNew] = useState(false);
  const [status, setStatus] = useState("");

  const endpoint = useMemo(() => {
    if (activeSource === "all") return `${API_BASE_URL}/jobs?limit=500`;
    return `${API_BASE_URL}/jobs?source=${encodeURIComponent(activeSource)}&limit=500`;
  }, [activeSource]);

  const fetchJobs = async () => {
    setLoading(true);
    setStatus("");
    try {
      const res = await fetch(endpoint);
      const txt = await res.text();

      if (!res.ok) {
        // próbáljunk JSON-t, ha az
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
    fetchJobs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint]);

  const visibleJobs = useMemo(() => {
    if (!onlyNew) return jobs;
    return jobs.filter((j) => j.firstSeen && hoursSince(j.firstSeen) <= 24);
  }, [jobs, onlyNew]);

  return (
    <div className="job-watcher">
      <div className="job-watcher-header">
        <div>
          <h1>💼 Állásfigyelő</h1>
          <div className="job-meta">
            Forrásonként gyűjtött hirdetések, automatikus frissítéssel.
          </div>
        </div>

        <div className="job-actions">
          <label className="job-checkbox">
            <input
              type="checkbox"
              checked={onlyNew}
              onChange={(e) => setOnlyNew(e.target.checked)}
            />
            Csak új (24h)
          </label>

          <button className="job-btn" onClick={fetchJobs} disabled={loading}>
            {loading ? "Betöltés…" : "Frissítés"}
          </button>
        </div>
      </div>

      <div className="job-tabs">
        {SOURCES.map((s) => (
          <button
            key={s.key}
            className={`job-tab ${activeSource === s.key ? "active" : ""}`}
            onClick={() => setActiveSource(s.key)}
          >
            {s.label}
          </button>
        ))}
      </div>

      {status && <div className="job-status">{status}</div>}

      {loading ? (
        <div className="job-status">Betöltés…</div>
      ) : visibleJobs.length === 0 ? (
        <div className="job-status">Nincs találat.</div>
      ) : (
        <ul className="job-list">
          {visibleJobs.map((job) => {
            const isNew = job.firstSeen && hoursSince(job.firstSeen) <= 24;
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

                <div className="job-meta">
                  {isNew ? <span className="job-badge">Új</span> : null}
                  <span>
                    Első találat:{" "}
                    {job.firstSeen ? new Date(job.firstSeen).toLocaleString("hu-HU") : "—"}
                  </span>
                  <span className="dot">•</span>
                  <span>
                    Utoljára látta:{" "}
                    {job.lastSeen ? new Date(job.lastSeen).toLocaleString("hu-HU") : "—"}
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
