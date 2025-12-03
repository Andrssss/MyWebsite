import "./SubjectInfo.css";
import React, { useState, useEffect } from "react";

// Ékezetmentesítés
const removeAccents = (str) =>
  str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

// Közvetlenül a Netlify functiont hívjuk
const API_BASE_URL = "/.netlify/functions";

// A backend JSON-ben:
// id, name, user, difficulty, usefulness, general, duringSemester, exam, year, semester, user_id
const initialNewEntry = {
  name: "",
  user: "anonim",
  difficulty: "",
  general: "",
  duringSemester: "",
  exam: "",
  year: new Date().getFullYear(),
  semester: "",
};

const SubjectInfo = () => {
  const [subjects, setSubjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [userId, setUserId] = useState(() => localStorage.getItem("userId") || null);
  const [editingReviewId, setEditingReviewId] = useState(null);

  // Kereső és félév
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedSemester, setSelectedSemester] = useState("all");

  // Új vélemény modal
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [newEntry, setNewEntry] = useState(initialNewEntry);

  // Autocomplete javaslatok
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [suggestions, setSuggestions] = useState([]);

  // Segédfüggvény a form visszaállításához
  const resetNewEntry = () => {
    setNewEntry((prev) => ({
      ...initialNewEntry,
      user: localStorage.getItem("savedUserName") || "anonim",
    }));
    setEditingReviewId(null);
  };

  useEffect(() => {
    // userId beállítása, ha még nincs
    let storedUserId = localStorage.getItem("userId");
    if (!storedUserId) {
      storedUserId = "user-" + Math.random().toString(36).substr(2, 9);
      localStorage.setItem("userId", storedUserId);
    }
    setUserId(storedUserId);

    // Mentett felhasználónév betöltése, ha van
    const savedUserName = localStorage.getItem("savedUserName");
    if (savedUserName) {
      setNewEntry((prev) => ({ ...prev, user: savedUserName }));
    }

    const fetchTable = async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/reviews`);
        if (!response.ok) {
          throw new Error("Nem sikerült betölteni az adatokat");
        }
        const data = await response.json();

        setSubjects(
          data.map((row) => ({
            user: row.user ?? "N/A",
            name: row.name ?? "N/A",
            difficulty: row.difficulty ?? "N/A",
            general: row.general ?? "",
            duringSemester: row.duringSemester ?? "N/A",
            exam: row.exam ?? "N/A",
            year: row.year ?? "N/A",
            semester: row.semester ?? "N/A",
            user_id: row.user_id ?? "N/A",
            id: row.id ?? null,
          }))
        );
      } catch (err) {
        console.error("Hiba történt az adatok lekérésekor:", err);
      } finally {
        setLoading(false);
      }
    };

    fetchTable();
  }, []);

  // Keresés és félév szűrés
  const handleSemesterChange = (e) => {
    setSelectedSemester(e.target.value);
    setSearchTerm("");
  };

  const handleSearchTermChange = (e) => {
    const val = e.target.value;
    setSearchTerm(val);
    if (val.trim().length > 0) {
      setSelectedSemester("all");
    }
  };

  // Autocomplete logika
  // comment
  const handleNameFocus = () => {
    const allNames = [...new Set(subjects.map((subj) => subj.name))].sort(
      (a, b) => a.localeCompare(b)
    );
    setSuggestions(allNames);
    setShowSuggestions(true);
  };

  const handleNameChange = (e) => {
    const { value } = e.target;
    setNewEntry((prev) => ({ ...prev, name: value }));

    if (value.trim().length === 0) {
      const allNames = [...new Set(subjects.map((subj) => subj.name))].sort(
        (a, b) => a.localeCompare(b)
      );
      setSuggestions(allNames);
    } else {
      const search = removeAccents(value.toLowerCase());
      const filtered = [
        ...new Set(
          subjects
            .map((subj) => subj.name)
            .filter((name) =>
              removeAccents(name.toLowerCase()).includes(search)
            )
        ),
      ].sort((a, b) => a.localeCompare(b));
      setSuggestions(filtered);
    }

    const exactMatch = subjects.find((s) => s.name === value.trim());
    if (exactMatch) {
      setNewEntry((prev) => ({ ...prev, semester: exactMatch.semester }));
    }
    setShowSuggestions(true);
  };

  const handleSuggestionClick = (suggestedName) => {
    const foundSubject = subjects.find((s) => s.name === suggestedName);
    setNewEntry((prev) => ({
      ...prev,
      name: suggestedName,
      semester: foundSubject ? foundSubject.semester : "",
    }));
    setShowSuggestions(false);
  };

  const handleInputChange = (e) => {
    const { name, value } = e.target;
    setNewEntry((prev) => ({ ...prev, [name]: value }));
    if (name === "user") {
      localStorage.setItem("savedUserName", value);
    }
  };

  const handleModalClose = (e) => {
    if (e.target.className === "modal-overlay") {
      setIsModalOpen(false);
      setShowSuggestions(false);
      resetNewEntry();
    }
  };

  const openEditModal = (review, subjectName, subjectSemester) => {
    setNewEntry({
      name: subjectName,
      user: review.user !== "N/A" ? review.user : "anonim",
      difficulty: review.difficulty !== "N/A" ? review.difficulty : "",
      general: review.general !== "N/A" ? review.general : "",
      duringSemester:
        review.duringSemester !== "N/A" ? review.duringSemester : "",
      exam: review.exam !== "N/A" ? review.exam : "",
      year: review.year !== "N/A" ? review.year : new Date().getFullYear(),
      semester: subjectSemester,
    });
    setEditingReviewId(review.id);
    setIsModalOpen(true);
  };




 
const handleDelete = async (id) => {
  console.log("🟠 Delete button clicked for id =", id);

  if (!window.confirm("Biztosan törölni szeretnéd ezt a véleményt?")) return;

  try {
    const response = await fetch(`${API_BASE_URL}/reviews/${id}`, {
      method: "DELETE",
    });

    const txt = await response.text();
    console.log("🔴 DELETE RESULT:", response.status, txt);

    if (!response.ok && response.status !== 204) {
      throw new Error(txt || "Hiba történt a törlés során.");
    }

    alert("Vélemény sikeresen törölve.");
    setSubjects((prev) => prev.filter((subject) => subject.id !== id));
  } catch (err) {
    console.error("DELETE ERROR:", err);
    alert(`Hiba történt: ${err.message}`);
  }
};





  const handleUpdate = async (e) => {
    e.preventDefault();
    if (!editingReviewId) {
      alert("Hiba: Nem található a szerkesztendő vélemény azonosítója!");
      return;
    }

    const payload = {};
    Object.keys(newEntry).forEach((key) => {
      if (newEntry[key] !== "N/A" && newEntry[key] !== "") {
        payload[key] = newEntry[key];
      }
    });
    payload.user_id = userId;

    try {
      const response = await fetch(
        `${API_BASE_URL}/reviews/${editingReviewId}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );
      if (!response.ok) throw new Error("Hiba történt a módosítás során.");
      const updated = await response.json();

      alert("Vélemény sikeresen módosítva.");
      setSubjects((prev) =>
        prev.map((subject) =>
          subject.id === editingReviewId ? { ...subject, ...updated } : subject
        )
      );
      resetNewEntry();
      setIsModalOpen(false);
    } catch (err) {
      alert(`Hiba történt: ${err.message}`);
    }
  };

  const openModalForSubject = (subjectName, semester) => {
    setNewEntry((prev) => ({
      ...prev,
      name: subjectName,
      semester,
      year: new Date().getFullYear(),
    }));
    setIsModalOpen(true);
    setShowSuggestions(false);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (newEntry.difficulty.trim() !== "") {
      const d = parseInt(newEntry.difficulty, 10);
      if (isNaN(d)) {
        alert("A nehézség mezőnek számot kell tartalmaznia!");
        return;
      }
    }

    const foundSubject = subjects.find((s) => s.name === newEntry.name.trim());
    if (!foundSubject) {
      alert("Nincs ilyen tárgy a meglévő listában!");
      return;
    }

    if (!newEntry.user) newEntry.user = "anonim";

    if (
      !newEntry.difficulty.trim() &&
      !newEntry.general.trim() &&
      !newEntry.duringSemester.trim() &&
      !newEntry.exam.trim()
    ) {
      alert("Minden mezőt üresen hagytál, tölts ki legalább egyet!");
      return;
    }

    const payload = {
      ...newEntry,
      user_id: userId,
      semester: foundSubject.semester,
    };

    try {
      const response = await fetch(`${API_BASE_URL}/reviews`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=UTF-8",
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const txt = await response.text();
        throw new Error(txt || "Hiba történt az adatbeküldés során");
      }

      const created = await response.json();

      alert("Adatok sikeresen beküldve!");
      setSubjects((prev) => [...prev, created]);
      resetNewEntry();
      setIsModalOpen(false);
      setShowSuggestions(false);
    } catch (err) {
      alert(`Hiba történt: ${err.message}`);
    }
  };

  const filteredSubjects = subjects.filter((subject) => {
    const normSearch = removeAccents(searchTerm.toLowerCase());
    const normName = removeAccents(subject.name.toLowerCase());
    const matchesSearch = normName.includes(normSearch);
    const matchesSemester =
      selectedSemester === "all" ||
      subject.semester === parseInt(selectedSemester, 10);
    return matchesSearch && matchesSemester;
  });

  if (loading)
    return (
      <div
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          width: "100vw",
          height: "100vh",
          zIndex: 9999,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: "1.5rem",
        }}
      >
        Betöltés...
      </div>
    );

  return (
    <div className="subject-info-container">
      {/* Keresés és szűrő */}
      <div className="search-filter-container">
        <input
          type="text"
          placeholder="Keresés tárgy neve alapján..."
          value={searchTerm}
          onChange={handleSearchTermChange}
          className="search-bar"
        />
        <select
          value={selectedSemester}
          onChange={handleSemesterChange}
          className="semester-filter"
        >
          <option value="all">Összes félév</option>
          {[...new Set(subjects.map((s) => s.semester))]
            .filter((sem) => sem !== "N/A")
            .sort((a, b) => a - b)
            .map((sem) => (
              <option key={sem} value={sem}>
                {sem}. félév
              </option>
            ))}
        </select>
        <button
          className="open-modal-button"
          onClick={() => setIsModalOpen(true)}
        >
          Feltöltés
        </button>
      </div>

      {/* Tárgyak listája */}
      {filteredSubjects.length > 0 ? (
        filteredSubjects
          .reduce((acc, s) => {
            const existing = acc.find((item) => item.name === s.name);

            const feedback = {
              user: s.user,
              user_id: s.user_id,
              year: s.year,
              difficulty: s.difficulty,
              general: s.general,
              duringSemester: s.duringSemester,
              exam: s.exam,
              id: s.id,
            };

            const isRealUser =
              s.user &&
              s.user !== "N/A" &&
              s.user.trim() !== "" &&
              s.user !== "placeholder";

            if (existing) {
              // már van ilyen nevű tárgy a listában
              if (isRealUser) {
                existing.users.push(feedback);
              }
            } else {
              // új tárgy blokk
              acc.push({
                name: s.name,
                semester: s.semester,
                id: s.id,
                users: isRealUser ? [feedback] : [],
              });
            }

            return acc;
          }, [])
          .map((group, i) => (
            <div key={i} className="subject-card">
              <div className="subject-header">
                <h3 className="subject-title">{group.name}</h3>
              </div>
              <div className="subject-semester">
                <p>Félév: {group.semester}. félév</p>
              </div>
              <div className="subject-details">
                {group.users.map((u, idx) => (
                  <div key={idx} className="user-feedback">
                    {u.id === null ? (
                      <p className="no-feedback">{u.user}</p>
                    ) : (
                      <>
                        <div className="feedback-header">
                          <h4>{u.user}</h4>
                          {u.user_id === userId && (
                            <div className="feedback-buttons">
                              <button
                                className="edit-button"
                                onClick={() =>
                                  openEditModal(u, group.name, group.semester)
                                }
                              >
                                Szerkesztés
                              </button>
                              <button
                                type="button"
                                className="delete-button"
                                style={{ pointerEvents: "auto" }}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  e.preventDefault();
                                  console.log("🟠 Delete button clicked for id =", u.id);
                                  handleDelete(u.id);
                                }}
                              >
                                Törlés
                              </button>

                            </div>
                          )}
                        </div>
                        <p>
                          <strong>Év:</strong> {u.year}
                        </p>
                        {u.difficulty !== "N/A" && (
                          <p>
                            <strong>Nehézség:</strong> {u.difficulty}/10
                          </p>
                        )}
                        {u.general && (
                          <p>
                            <strong>Általános:</strong> {u.general}
                          </p>
                        )}
                        {u.duringSemester !== "N/A" && (
                          <p>
                            <strong>Évközben:</strong> {u.duringSemester}
                          </p>
                        )}
                        {u.exam !== "N/A" && (
                          <p>
                            <strong>Vizsga:</strong> {u.exam}
                          </p>
                        )}
                      </>
                    )}
                  </div>
                ))}
                {group.name !== "Általános info" && (
                  <div className="user-feedback write-review">
                    <p>
                      Írj te is véleményt{" "}
                      <button
                        className="write-review-button"
                        onClick={() =>
                          openModalForSubject(group.name, group.semester)
                        }
                      >
                        itt
                      </button>
                    </p>
                  </div>
                )}
              </div>
            </div>
          ))
      ) : (
        <p className="no-results">Nincs találat a keresett kifejezésre.</p>
      )}

      {/* Új vélemény modal */}
      {isModalOpen && (
        <div className="modal-overlay" onClick={handleModalClose}>
          <div className="modal-content">
            <button
              className="close-button"
              onClick={() => {
                setIsModalOpen(false);
                setShowSuggestions(false);
                resetNewEntry();
              }}
            >
              x
            </button>
            <form
              onSubmit={editingReviewId ? handleUpdate : handleSubmit}
              className="submission-form"
            >
              <h2>Új vélemény hozzáadása</h2>
              <div className="form-group" style={{ position: "relative" }}>
                <label htmlFor="name">Tárgynév:</label>
                <input
                  type="text"
                  id="name"
                  name="name"
                  value={newEntry.name}
                  onChange={handleNameChange}
                  onFocus={handleNameFocus}
                  placeholder="Kattints ide vagy írj be valamit..."
                  autoComplete="off"
                  required
                />
                {showSuggestions && suggestions.length > 0 && (
                  <div className="autocomplete-container">
                    {suggestions.map((item, idx) => (
                      <div
                        key={idx}
                        className="autocomplete-item"
                        onClick={() => handleSuggestionClick(item)}
                      >
                        {item}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="form-group">
                <label htmlFor="user">Becenév:</label>
                <input
                  type="text"
                  id="user"
                  name="user"
                  value={newEntry.user === "anonim" ? "" : newEntry.user}
                  onChange={handleInputChange}
                  placeholder="anonim"
                />
              </div>
              <div className="form-group">
                <label htmlFor="difficulty">Nehézség: </label>
                <input
                  type="text"
                  id="difficulty"
                  name="difficulty"
                  value={newEntry.difficulty}
                  onChange={handleInputChange}
                  placeholder="Szám (0-10)"
                />
              </div>
              <div className="form-group">
                <label htmlFor="general">Általános:</label>
                <textarea
                  id="general"
                  name="general"
                  value={newEntry.general}
                  onChange={handleInputChange}
                ></textarea>
              </div>
              <div className="form-group">
                <label htmlFor="duringSemester">Évközben:</label>
                <textarea
                  id="duringSemester"
                  name="duringSemester"
                  value={newEntry.duringSemester}
                  onChange={handleInputChange}
                  placeholder="( Nem kötelező )"
                ></textarea>
              </div>
              <div className="form-group">
                <label htmlFor="exam">Vizsga:</label>
                <textarea
                  id="exam"
                  name="exam"
                  value={newEntry.exam}
                  onChange={handleInputChange}
                  placeholder="( Nem kötelező )"
                ></textarea>
              </div>
              <div className="form-group">
                <label htmlFor="year">Év:</label>
                <input
                  type="number"
                  id="year"
                  name="year"
                  value={newEntry.year}
                  onChange={handleInputChange}
                />
              </div>
              <button type="submit">Hozzáadás</button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default SubjectInfo;
