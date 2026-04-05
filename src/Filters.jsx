import React, { useEffect, useState } from "react";
import "./Filters.css";

const API = "/.netlify/functions/filters";

const Filters = () => {
  const [filters, setFilters] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newWord, setNewWord] = useState("");
  const [error, setError] = useState(null);
  const [undoStack, setUndoStack] = useState([]);
  const undoTimers = React.useRef({});

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
