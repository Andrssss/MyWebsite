import React, { useEffect, useMemo, useState } from "react";
import "./JobWatcher.css";

const API_BASE_URL = "/.netlify/functions";

const hoursSince = (iso) => {
  const ms = Date.now() - new Date(iso).getTime();
  return ms / (1000 * 60 * 60);
};

const JobWatcher = () => {
  const [sources, setSources] = useState([]); // [{key,label,count,lastSeen}]
  const [activeSource, setActiveSource] = useState("all");
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingSources, setLoadingSources] = useState(true);
  const [onlyNew, setOnlyNew] = useState(false);
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");

  // sources betöltés
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

  const endpoint = useMemo(() => {
    const limit = 500;
    if (activeSource === "all") return `${API_BASE_URL}/jobs?limit=${limit}`;
    return `${API_BASE_URL}/jobs?source=${encodeURIComponent(activeSource)}&limit=${limit}`;
  }, [activeSource]);

  const fetchJobs = async () => {
    setLoading(true);
    setStatus("");
    try {
      const res = await fetch(endpoint);
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
  }, []);

  useEffect(() => {
    fetchJobs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint]);

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
        return t.includes(nq) || d.includes(nq);
      });
    }

    return list;
  }, [jobs, onlyNew, q]);

  const tabs = useMemo(() => {
    // all + dynamic sources
    const dynamic = sources.map((s) => ({
      key: s.key,
      label: s.label ?? s.key,
      count: s.count,
    }));
    return [{ key: "all", label: "Összes" }, ...dynamic];
  }, [sources]);

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
              onChange={(e) => setOnlyNew(e.target.checked)}
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
        {loadingSources && tabs.length === 1 ? (
          <div className="job-status">Források betöltése…</div>
        ) : (
          tabs.map((s) => (
            <button
              key={s.key}
              className={`job-tab ${activeSource === s.key ? "active" : ""}`}
              onClick={() => setActiveSource(s.key)}
              title={s.key === "all" ? "Összes forrás" : s.key}
            >
              {s.label}
              {typeof s.count === "number" ? (
                <span className="job-tab-count">{s.count}</span>
              ) : null}
            </button>
          ))
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

                {job.description ? (
                  <div className="job-desc">{job.description}</div>
                ) : null}

                <div className="job-meta">
                  {isNew ? <span className="job-badge">Új</span> : null}
                  <span>
                    Első találat:{" "}
                    {job.firstSeen
                      ? new Date(job.firstSeen).toLocaleString("hu-HU")
                      : "—"}
                  </span>
                  <span className="dot">•</span>
                  <span>
                    Utoljára látta:{" "}
                    {job.lastSeen
                      ? new Date(job.lastSeen).toLocaleString("hu-HU")
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
