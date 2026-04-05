import React, { useEffect, useState } from "react";
import "./Filters.css";

const API = "/.netlify/functions/filters";

const Filters = () => {
  const [filters, setFilters] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newWord, setNewWord] = useState("");
  const [error, setError] = useState(null);
  const [undoStack, setUndoStack] = useState([]);
  const [recentlyAdded, setRecentlyAdded] = useState([]);
  const [purging, setPurging] = useState({});
  const undoTimers = React.useRef({});
  const addedTimers = React.useRef({});

  const load = async () => {
    try {
      const res = await fetch(API);
      const data = await res.json();
      if (Array.isArray(data)) setFilters(data.sort((a, b) => b.id - a.id));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const add = async () => {
    const word = newWord.trim();
    if (!word) return;
    setError(null);
    try {
      const res = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ word }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error); return; }
      setFilters(prev => [...prev, data].sort((a, b) => b.id - a.id));
      setNewWord("");
      const uid = Date.now() + "-" + data.id;
      setRecentlyAdded(prev => [...prev, { word: data.word, uid }]);
      addedTimers.current[uid] = setTimeout(() => {
        setRecentlyAdded(prev => prev.filter(r => r.uid !== uid));
        delete addedTimers.current[uid];
      }, 15000);
    } catch (e) {
      setError(e.message);
    }
  };

  const remove = async (id) => {
    const removed = filters.find(f => f.id === id);
    setError(null);
    try {
      await fetch(API, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      setFilters(prev => prev.filter(f => f.id !== id));
      const uid = Date.now() + "-" + id;
      setUndoStack(prev => [...prev, { ...removed, uid }]);
      undoTimers.current[uid] = setTimeout(() => {
        setUndoStack(prev => prev.filter(u => u.uid !== uid));
        delete undoTimers.current[uid];
      }, 8000);
    } catch (e) {
      setError(e.message);
    }
  };

  const countJobs = async (item) => {
    setPurging(prev => ({ ...prev, [item.uid]: "counting" }));
    setError(null);
    try {
      const res = await fetch(API, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ word: item.word, action: "count" }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error); setPurging(prev => { const n = { ...prev }; delete n[item.uid]; return n; }); return; }
      setPurging(prev => ({ ...prev, [item.uid]: { counted: true, count: data.count } }));
    } catch (e) {
      setError(e.message);
      setPurging(prev => { const n = { ...prev }; delete n[item.uid]; return n; });
    }
  };

  const confirmPurge = async (item) => {
    const prev = purging[item.uid];
    setPurging(p => ({ ...p, [item.uid]: "deleting" }));
    setError(null);
    try {
      const res = await fetch(API, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ word: item.word, action: "delete" }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error); setPurging(p => ({ ...p, [item.uid]: prev })); return; }
      setPurging(p => ({ ...p, [item.uid]: { done: true, count: data.deleted } }));
      setTimeout(() => {
        setRecentlyAdded(r => r.filter(x => x.uid !== item.uid));
        clearTimeout(addedTimers.current[item.uid]);
        delete addedTimers.current[item.uid];
        setPurging(p => { const n = { ...p }; delete n[item.uid]; return n; });
      }, 3000);
    } catch (e) {
      setError(e.message);
      setPurging(p => ({ ...p, [item.uid]: prev }));
    }
  };

  const dismissAdded = (item) => {
    clearTimeout(addedTimers.current[item.uid]);
    delete addedTimers.current[item.uid];
    setRecentlyAdded(prev => prev.filter(r => r.uid !== item.uid));
  };

  const undo = async (item) => {
    clearTimeout(undoTimers.current[item.uid]);
    delete undoTimers.current[item.uid];
    setUndoStack(prev => prev.filter(u => u.uid !== item.uid));
    setError(null);
    try {
      const res = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ word: item.word }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error); return; }
      setFilters(prev => [...prev, data].sort((a, b) => b.id - a.id));
    } catch (e) {
      setError(e.message);
    }
  };

  return (
    <div className="filters-page">
      <div className="filters-header">
        <div>
          <h1>Filters</h1>
          <a href="/allasfigyelo" className="filters-btn" style={{ textDecoration: "none", display: "inline-block", marginTop: 8 }}>← Vissza</a>
        </div>
      </div>

      {error && <p style={{ color: "#ef4444", margin: "12px 0" }}>{error}</p>}

      <div className="filter-add-row">
        <input
          className="filter-input"
          placeholder="Új szó..."
          value={newWord}
          onChange={e => setNewWord(e.target.value)}
          onKeyDown={e => e.key === "Enter" && add()}
        />
        <button className="filters-btn" onClick={add}>Hozzáadás</button>
      </div>

      {loading ? (
        <p className="filters-status">Betöltés…</p>
      ) : (
        <div className="filter-group">
          <h2 className="filter-group-title">Blacklist ({filters.length})</h2>
          <div className="filter-chips">
            {filters.map(f => (
              <span key={f.id} className="filter-chip">
                {f.word}
                <button
                  className="filter-chip-x"
                  onClick={() => remove(f.id)}
                  title="Törlés"
                >×</button>
              </span>
            ))}
            {filters.length === 0 && (
              <span style={{ color: "#666", fontSize: 14 }}>Nincs szó a listában.</span>
            )}
          </div>
        </div>
      )}

      {recentlyAdded.length > 0 && (
        <div className="undo-stack purge-stack">
          {recentlyAdded.map(item => (
            <div key={item.uid} className="undo-toast purge-toast">
              <span className="undo-toast-text">
                Hozzáadva: <strong>{item.word}</strong>
              </span>
              {purging[item.uid]?.done ? (
                <span className="purge-done">✓ {purging[item.uid].count} hirdetés törölve</span>
              ) : purging[item.uid]?.counted ? (
                purging[item.uid].count > 0 ? (
                  <>
                    <span className="purge-count">{purging[item.uid].count} találat</span>
                    <button
                      className="undo-toast-btn purge-btn"
                      onClick={() => confirmPurge(item)}
                    >
                      Törlés megerősítése
                    </button>
                  </>
                ) : (
                  <span className="purge-count">0 találat</span>
                )
              ) : (
                <button
                  className="undo-toast-btn purge-btn"
                  onClick={() => countJobs(item)}
                  disabled={purging[item.uid] === "counting" || purging[item.uid] === "deleting"}
                >
                  {purging[item.uid] === "counting" ? "Keresés…" : purging[item.uid] === "deleting" ? "Törlés…" : "🗑 Hirdetések törlése"}
                </button>
              )}
              <button className="undo-toast-close" onClick={() => dismissAdded(item)}>×</button>
            </div>
          ))}
        </div>
      )}

      {undoStack.length > 0 && (
        <div className="undo-stack">
          {undoStack.map(item => (
            <div key={item.uid} className="undo-toast">
              <span className="undo-toast-text">Törölve: <strong>{item.word}</strong></span>
              <button className="undo-toast-btn" onClick={() => undo(item)}>↩ Visszavonás</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default Filters;
