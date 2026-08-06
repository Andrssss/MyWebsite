import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { adminFetch } from "./adminAuth";
import "./Filters.css";

const API = "/.netlify/functions/categories";

const Categories = () => {
  const navigate = useNavigate();
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Új kategória
  const [newName, setNewName] = useState("");
  const [newKeywords, setNewKeywords] = useState("");

  // Keyword hozzáadás meglévő kategóriához
  const [addingKeyword, setAddingKeyword] = useState({}); // { [id]: inputValue }

  // Kapcsolódó technológia hozzáadás meglévő kategóriához — csak a
  // canonical TECH_KEYWORDS címkék közül választható (datalist), mert a
  // backend úgyis eldobja, ami nincs a listán (ld. categories.js VALID_TECH_LABELS).
  const [addingTech, setAddingTech] = useState({}); // { [id]: inputValue }
  const [allTechLabels, setAllTechLabels] = useState([]);

  // Kiválasztott kategória
  const [selectedId, setSelectedId] = useState(null);

  // Undo stack (kategória törlés)
  const [undoStack, setUndoStack] = useState([]);
  const undoTimers = React.useRef({});

  // Undo stack (kulcsszó törlés)
  const [kwUndoStack, setKwUndoStack] = useState([]);
  const kwUndoTimers = React.useRef({});

  const load = async () => {
    try {
      const res = await fetch(API);
      const data = await res.json();
      if (Array.isArray(data)) setCategories(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  useEffect(() => {
    fetch("/.netlify/functions/jobs/technologies")
      .then((res) => res.json())
      .then((data) => { if (Array.isArray(data)) setAllTechLabels(data); })
      .catch(() => setAllTechLabels([]));
  }, []);

  // Új kategória hozzáadása
  const addCategory = async () => {
    const name = newName.trim();
    if (!name) return;
    setError(null);
    const keywords = newKeywords
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean);
    try {
      const res = await adminFetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, keywords }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error); return; }
      setCategories((prev) => [...prev, data]);
      setNewName("");
      setNewKeywords("");
    } catch (e) {
      setError(e.message);
    }
  };

  // Kategória törlése
  const removeCategory = async (id) => {
    const removed = categories.find((c) => c.id === id);
    setError(null);
    try {
      await adminFetch(API, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      setCategories((prev) => prev.filter((c) => c.id !== id));
      // Undo toast
      const uid = Date.now() + "-" + id;
      setUndoStack((prev) => [...prev, { ...removed, uid }]);
      undoTimers.current[uid] = setTimeout(() => {
        setUndoStack((prev) => prev.filter((u) => u.uid !== uid));
        delete undoTimers.current[uid];
      }, 8000);
    } catch (e) {
      setError(e.message);
    }
  };

  // Undo: re-create category
  const undo = async (item) => {
    clearTimeout(undoTimers.current[item.uid]);
    delete undoTimers.current[item.uid];
    setUndoStack((prev) => prev.filter((u) => u.uid !== item.uid));
    setError(null);
    try {
      const res = await adminFetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: item.name, keywords: item.keywords, technologies: item.technologies }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error); return; }
      setCategories((prev) => [...prev, data]);
    } catch (e) {
      setError(e.message);
    }
  };

  // Keyword törlése egy kategóriából
  const removeKeyword = async (cat, keyword) => {
    setError(null);
    const updated = cat.keywords.filter((k) => k !== keyword);
    try {
      const res = await adminFetch(API, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: cat.id, keywords: updated }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error); return; }
      setCategories((prev) => prev.map((c) => (c.id === cat.id ? data : c)));
      // Undo toast
      const uid = Date.now() + "-kw-" + cat.id + "-" + keyword;
      setKwUndoStack((prev) => [...prev, { catId: cat.id, catName: cat.name, keyword, uid }]);
      kwUndoTimers.current[uid] = setTimeout(() => {
        setKwUndoStack((prev) => prev.filter((u) => u.uid !== uid));
        delete kwUndoTimers.current[uid];
      }, 8000);
    } catch (e) {
      setError(e.message);
    }
  };

  // Keyword visszavonás
  const undoKeyword = async (item) => {
    clearTimeout(kwUndoTimers.current[item.uid]);
    delete kwUndoTimers.current[item.uid];
    setKwUndoStack((prev) => prev.filter((u) => u.uid !== item.uid));
    setError(null);
    const cat = categories.find((c) => c.id === item.catId);
    if (!cat) return;
    const merged = [...cat.keywords, item.keyword];
    try {
      const res = await adminFetch(API, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.catId, keywords: merged }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error); return; }
      setCategories((prev) => prev.map((c) => (c.id === item.catId ? data : c)));
    } catch (e) {
      setError(e.message);
    }
  };

  // Keyword hozzáadása egy kategóriához
  const addKeyword = async (cat) => {
    const input = (addingKeyword[cat.id] || "").trim();
    if (!input) return;
    setError(null);
    const newKws = input.split(",").map((k) => k.trim()).filter(Boolean);
    const merged = [...cat.keywords, ...newKws.filter((k) => !cat.keywords.some((ex) => ex.toLowerCase() === k.toLowerCase()))];
    try {
      const res = await adminFetch(API, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: cat.id, keywords: merged }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error); return; }
      setCategories((prev) => prev.map((c) => (c.id === cat.id ? data : c)));
      setAddingKeyword((prev) => ({ ...prev, [cat.id]: "" }));
    } catch (e) {
      setError(e.message);
    }
  };

  // Kapcsolódó technológia törlése egy kategóriából
  const removeTechnology = async (cat, tech) => {
    setError(null);
    const updated = (cat.technologies || []).filter((t) => t !== tech);
    try {
      const res = await adminFetch(API, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: cat.id, technologies: updated }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error); return; }
      setCategories((prev) => prev.map((c) => (c.id === cat.id ? data : c)));
    } catch (e) {
      setError(e.message);
    }
  };

  // Kapcsolódó technológia hozzáadása egy kategóriához — csak a canonical
  // listán szereplő címkéket fogadja el (a datalist ezt kínálja fel, de a
  // felhasználó szabadon is beírhat bármit, ezért itt is kiszűrjük).
  const addTechnology = async (cat) => {
    const input = (addingTech[cat.id] || "").trim();
    if (!input) return;
    setError(null);
    const validLower = new Map(allTechLabels.map((t) => [t.toLowerCase(), t]));
    const newTechs = input
      .split(",")
      .map((t) => validLower.get(t.trim().toLowerCase()))
      .filter(Boolean);
    if (newTechs.length === 0) {
      setError(`Nincs ilyen technológia: "${input}"`);
      return;
    }
    const existing = cat.technologies || [];
    const merged = [...existing, ...newTechs.filter((t) => !existing.includes(t))];
    try {
      const res = await adminFetch(API, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: cat.id, technologies: merged }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error); return; }
      setCategories((prev) => prev.map((c) => (c.id === cat.id ? data : c)));
      setAddingTech((prev) => ({ ...prev, [cat.id]: "" }));
    } catch (e) {
      setError(e.message);
    }
  };

  const selectedCat = categories.find((c) => c.id === selectedId);

  return (
    <div className="filters-page">
      <datalist id="category-tech-options">
        {allTechLabels.map((t) => <option key={t} value={t} />)}
      </datalist>

      <div className="filters-header">
        <h1>Kategóriák</h1>
        <button className="filters-btn" onClick={() => navigate("/allasfigyelo")}>← Vissza</button>
      </div>

      {error && <p style={{ color: "#ef4444", margin: "12px 0" }}>{error}</p>}

      {/* Új kategória */}
      <div className="filter-add-row" style={{ flexDirection: "column", alignItems: "stretch" }}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <input
            className="filter-input"
            placeholder="Kategória neve..."
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addCategory()}
          />
          <button className="filters-btn" onClick={addCategory}>Kategória hozzáadása</button>
        </div>
        <input
          className="filter-input"
          style={{ width: "100%", marginTop: 8 }}
          placeholder="Kulcsszavak (vesszővel elválasztva)..."
          value={newKeywords}
          onChange={(e) => setNewKeywords(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addCategory()}
        />
      </div>

      {loading ? (
        <p className="filters-status">Betöltés…</p>
      ) : (
        <>
          {/* Kategória választó tabok */}
          <div className="filter-chips" style={{ marginTop: 20, marginBottom: 16 }}>
            {categories.map((cat) => (
              <button
                key={cat.id}
                className={`filter-chip${selectedId === cat.id ? " filter-chip--active" : ""}`}
                onClick={() => setSelectedId(selectedId === cat.id ? null : cat.id)}
                style={{ cursor: "pointer" }}
              >
                {cat.name} ({cat.keywords.length})
              </button>
            ))}
          </div>

          {/* Kiválasztott kategória részletei */}
          {selectedCat && (
            <div className="filter-group">
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
                <h2 className="filter-group-title" style={{ margin: 0 }}>
                  {selectedCat.name} ({selectedCat.keywords.length})
                </h2>
                <button
                  className="filter-chip-x"
                  onClick={() => { removeCategory(selectedCat.id); setSelectedId(null); }}
                  title="Kategória törlése"
                  style={{ fontSize: 22, color: "#ef4444" }}
                >×</button>
              </div>
              <div className="filter-chips">
                {selectedCat.keywords.map((kw) => (
                  <span key={kw} className="filter-chip">
                    {kw}
                    <button
                      className="filter-chip-x"
                      onClick={() => removeKeyword(selectedCat, kw)}
                      title="Kulcsszó törlése"
                    >×</button>
                  </span>
                ))}
              </div>
              <div className="filter-add-row" style={{ marginTop: 8 }}>
                <input
                  className="filter-input"
                  placeholder="Kulcsszó hozzáadása (vessző = több)..."
                  value={addingKeyword[selectedCat.id] || ""}
                  onChange={(e) =>
                    setAddingKeyword((prev) => ({ ...prev, [selectedCat.id]: e.target.value }))
                  }
                  onKeyDown={(e) => e.key === "Enter" && addKeyword(selectedCat)}
                />
                <button className="filters-btn" onClick={() => addKeyword(selectedCat)}>+</button>
              </div>

              <h3 className="filter-group-title" style={{ marginTop: 20, fontSize: 15 }}>
                Kapcsolódó technológiák ({(selectedCat.technologies || []).length})
              </h3>
              <p className="filters-status" style={{ margin: "0 0 8px", fontSize: 13 }}>
                Ha a látogató ezt a kategóriát választja, ezek a technológia-szűrők
                is automatikusan bekerülnek.
              </p>
              <div className="filter-chips">
                {(selectedCat.technologies || []).map((t) => (
                  <span key={t} className="filter-chip">
                    {t}
                    <button
                      className="filter-chip-x"
                      onClick={() => removeTechnology(selectedCat, t)}
                      title="Technológia törlése"
                    >×</button>
                  </span>
                ))}
              </div>
              <div className="filter-add-row" style={{ marginTop: 8 }}>
                <input
                  className="filter-input"
                  list="category-tech-options"
                  placeholder="Technológia hozzáadása (vessző = több)..."
                  value={addingTech[selectedCat.id] || ""}
                  onChange={(e) =>
                    setAddingTech((prev) => ({ ...prev, [selectedCat.id]: e.target.value }))
                  }
                  onKeyDown={(e) => e.key === "Enter" && addTechnology(selectedCat)}
                />
                <button className="filters-btn" onClick={() => addTechnology(selectedCat)}>+</button>
              </div>
            </div>
          )}

          {!selectedCat && categories.length > 0 && (
            <p className="filters-status">Válassz egy kategóriát a szerkesztéshez.</p>
          )}
        </>
      )}

      {undoStack.length > 0 && (
        <div className="undo-stack">
          {undoStack.map((item) => (
            <div key={item.uid} className="undo-toast">
              <span className="undo-toast-text">Törölve: <strong>{item.name}</strong></span>
              <button className="undo-toast-btn" onClick={() => undo(item)}>↩ Visszavonás</button>
            </div>
          ))}
        </div>
      )}

      {kwUndoStack.length > 0 && (
        <div className="undo-stack">
          {kwUndoStack.map((item) => (
            <div key={item.uid} className="undo-toast">
              <span className="undo-toast-text">Kulcsszó törölve ({item.catName}): <strong>{item.keyword}</strong></span>
              <button className="undo-toast-btn" onClick={() => undoKeyword(item)}>↩ Visszavonás</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default Categories;
