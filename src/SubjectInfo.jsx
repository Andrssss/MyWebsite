import "./SubjectInfo.css";
import React, { useState, useEffect } from "react";

// Ékezetmentesítés
const removeAccents = (str) =>
  str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

const SubjectInfo = () => {
  const [subjects, setSubjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [userId, setUserId] = useState(() => localStorage.getItem("userId") || null);
  const [editingReviewId, setEditingReviewId] = useState(null);

  // Kereső és félév
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedSemester, setSelectedSemester] = useState("all");

  // Új vélemény modal
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [newEntry, setNewEntry] = useState({
    name: "",
    user: "anonim",
    difficulty: "",
    general: "",
    duringSemester: "",
    exam: "",
    year: new Date().getFullYear(),
    semester: "",
  });

  // Autocomplete javaslatok
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [suggestions, setSuggestions] = useState([]);

  useEffect(() => {
    let storedUserId = localStorage.getItem("userId");
    if (!storedUserId) {
      storedUserId = "user-" + Math.random().toString(36).substr(2, 9);
      localStorage.setItem("userId", storedUserId);
    }
    setUserId(storedUserId);

    const fetchTable = async () => {
      try {
        const response = await fetch("https://www.kacifant.hu/andris/test.php");
        if (!response.ok) {
          throw new Error("Nem sikerült betölteni az adatokat");
        }
        const html = await response.text();
        setSubjects(parseHTMLTable(html));
      } catch (err) {
        console.error("Hiba történt az adatok lekérésekor:", err);
      } finally {
        setLoading(false);
      }
    };

    // Hívás az adatok lekérésére
    fetchTable();

    // Ha van mentett user
    const savedUserName = localStorage.getItem("savedUserName");
    if (savedUserName) {
      setNewEntry((prev) => ({ ...prev, user: savedUserName }));
    }

    // (Esetleg ha kétszer szeretnéd hívni a fetchTable-t, itt maradhat a második hívás)
    fetchTable();
  }, [userId]);

  const parseHTMLTable = (html) => {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    const rows = doc.querySelectorAll("table tr");

    const arr = [];
    rows.forEach((row, index) => {
      if (index === 0) return; // Fejléc kihagyása
      const cells = row.querySelectorAll("td");
      arr.push({
        user: cells[0]?.textContent.trim() || "N/A",
        name: cells[1]?.textContent.trim() || "N/A",
        difficulty: cells[2]?.textContent.trim() || "N/A",
        general: cells[3]?.textContent.trim() || "",
        duringSemester: cells[4]?.textContent.trim() || "N/A",
        exam: cells[5]?.textContent.trim() || "N/A",
        year: parseInt(cells[6]?.textContent.trim(), 10) || "N/A",
        semester: parseInt(cells[7]?.textContent.trim(), 10) || "N/A",
        user_id: cells[8]?.textContent.trim() || "N/A",
        id: parseInt(cells[9]?.textContent.trim(), 10) || null, // ID mező hozzáadása
      });
    });
    return arr;
  };

  // --- Keresés + félév szűrés
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

  // =========== AUTOCOMPLETE LOGIKA ===========
  const handleNameFocus = () => {
    const allNames = [...new Set(subjects.map((subj) => subj.name))].sort((a, b) =>
      a.localeCompare(b)
    );
    setSuggestions(allNames);
    setShowSuggestions(true);
  };

  const handleNameChange = (e) => {
    const { value } = e.target;
    setNewEntry((prev) => ({ ...prev, name: value }));

    if (value.trim().length === 0) {
      const allNames = [...new Set(subjects.map((subj) => subj.name))].sort((a, b) =>
        a.localeCompare(b)
      );
      setSuggestions(allNames);
      setShowSuggestions(true);
    } else {
      setShowSuggestions(true);
      const search = removeAccents(value.toLowerCase());
      const filtered = [
        ...new Set(
          subjects
            .map((subj) => subj.name)
            .filter((name) => {
              const n = removeAccents(name.toLowerCase());
              return n.includes(search);
            })
        ),
      ].sort((a, b) => a.localeCompare(b));
      setSuggestions(filtered);
    }

    // Ha a beírt value pontosan egyezik egy subject.name-nel,
    // akkor automatikusan állítsuk be a semester mezőt is.
    const exactMatch = subjects.find((s) => s.name === value.trim());
    if (exactMatch) {
      setNewEntry((prev) => ({
        ...prev,
        semester: exactMatch.semester,
      }));
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm("Biztosan törölni szeretnéd ezt a véleményt?")) {
      return;
    }
  
    try {
      const response = await fetch("https://www.kacifant.hu/andris/delete.php", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ id, user_id: userId }).toString(),
      });
  
      if (!response.ok) {
        throw new Error("Hiba történt a törlés során.");
      }
  
      alert("Vélemény sikeresen törölve.");
  
      setTimeout(() => {
        setSubjects((prevSubjects) => prevSubjects.filter((subject) => subject.id !== id));
      }, 200);
  
      // Ha létezik a fetchTable, frissítsük az adatokat is
      if (typeof fetchTable === "function") {
        await fetchTable();
      }
    } catch (err) {
      alert(`Hiba történt: ${err.message}`);
    }
  };

  const handleSuggestionClick = (suggestedName) => {
    const foundSubject = subjects.find((s) => s.name === suggestedName);
  
    if (foundSubject) {
      setNewEntry((prev) => ({
        ...prev,
        name: suggestedName,
        semester: foundSubject.semester,
      }));
    } else {
      setNewEntry((prev) => ({ ...prev, name: suggestedName, semester: "" }));
    }
  
    setShowSuggestions(false);
  };

  // --- Új vélemény egyéb mezők
  const handleInputChange = (e) => {
    const { name, value } = e.target;
    setNewEntry((prev) => ({ ...prev, [name]: value }));
    if (name === "user") {
      localStorage.setItem("savedUserName", value);
    }
  };

  // Modal bezárás
  const handleModalClose = (e) => {
    if (e.target.className === "modal-overlay") {
      setIsModalOpen(false);
      setShowSuggestions(false);
    }
    if (e.target.className === "modal-overlay") {
      setIsModalOpen(false);
      setNewEntry((prev) => ({
        ...prev,
        name: "",
        difficulty: "",
        general: "",
        duringSemester: "",
        exam: "",
        year: new Date().getFullYear(),
        semester: "",
      }));
      setEditingReviewId(null);
    }
  };

  const openEditModal = (review) => {
    setNewEntry({
      name: review.name !== "N/A" ? review.name : "",
      user: review.user !== "N/A" ? review.user : "anonim",
      difficulty: review.difficulty !== "N/A" ? review.difficulty : "",
      general: review.general !== "N/A" ? review.general : "",
      duringSemester: review.duringSemester !== "N/A" ? review.duringSemester : "",
      exam: review.exam !== "N/A" ? review.exam : "",
      year: review.year !== "N/A" ? review.year : new Date().getFullYear(),
      semester: review.semester !== "N/A" ? review.semester : "",
    });
    setEditingReviewId(review.id);
    setIsModalOpen(true);
  };



  const handleUpdate = async (e) => {
    e.preventDefault();
  
    if (!editingReviewId) {
      alert("Hiba: Nem található a szerkesztendő vélemény azonosítója!");
      return;
    }
  
    const formData = new URLSearchParams();
    Object.keys(newEntry).forEach((key) => {
      if (newEntry[key] !== "N/A" && newEntry[key] !== "") {
        formData.append(key, newEntry[key]);
      }
    });
  
    formData.set("user_id", userId);
    formData.append("id", editingReviewId);
  
    try {
      const response = await fetch("https://www.kacifant.hu/andris/edit.php", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        mode: "cors",
        body: formData.toString(),
      });
  
      if (!response.ok) {
        throw new Error("Hiba történt a módosítás során.");
      }
  
      alert("Vélemény sikeresen módosítva.");
  
      setSubjects((prevSubjects) =>
        prevSubjects.map((subject) =>
          subject.id === editingReviewId
            ? { ...subject, ...newEntry }
            : subject
        )
      );
  
      setNewEntry((prev) => ({
        ...prev,
        name: "",
        difficulty: "",
        general: "",
        duringSemester: "",
        exam: "",
        year: new Date().getFullYear(),
        semester: "",
      }));
      setIsModalOpen(false);
      setEditingReviewId(null);
    } catch (err) {
      alert(`Hiba történt: ${err.message}`);
    }
  };


  // ★★ Új segédfüggvény: Modal megnyitása a kiválasztott tárgy előzetes kitöltésével ★★
  const openModalForSubject = (subjectName, semester) => {
    setNewEntry((prev) => ({
      ...prev,
      name: subjectName,
      semester: semester,
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
        alert("A nehézség mezőnek számot kell tartalmaznia !");
        return;
      }
    }
  
    const foundSubject = subjects.find((s) => s.name === newEntry.name.trim());
    if (!foundSubject) {
      alert("Nincs ilyen tárgy a meglévő listában!");
      return;
    }
  
    if (!newEntry.user) {
      newEntry.user = "anonim";
    }
  
    const isDifficultyEmpty = !newEntry.difficulty.trim();
    const isGeneralEmpty = !newEntry.general.trim();
    const isDuringEmpty = !newEntry.duringSemester.trim();
    const isExamEmpty = !newEntry.exam.trim();
  
    if (isDifficultyEmpty && isGeneralEmpty && isDuringEmpty && isExamEmpty) {
      alert("Minden mezőt üresen hagytál, tölts ki legalább egyet!");
      return;
    }
  
    const formData = new URLSearchParams();
    Object.keys(newEntry).forEach((key) => formData.append(key, newEntry[key]));
    formData.set("user_id", userId);
    formData.set("semester", foundSubject.semester);
  
    try {
      const response = await fetch("https://www.kacifant.hu/andris/submit.php", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        },
        body: formData.toString(),
      });
  
      const responseText = await response.text();
  
      if (!response.ok || !responseText.startsWith("SUCCESS:")) {
        throw new Error(responseText || "Hiba történt az adatbeküldés során");
      }
  
      const newId = parseInt(responseText.replace("SUCCESS:", "").trim(), 10);
      if (isNaN(newId)) {
        throw new Error("Hibás ID érték a szerver válaszában.");
      }
  
      alert("Adatok sikeresen beküldve!");
  
      const newSubject = { ...newEntry, id: newId, user_id: userId };
  
      setSubjects((prevSubjects) => [...prevSubjects, newSubject]);
  
      setNewEntry((prev) => ({
        ...prev,
        name: "",
        difficulty: "",
        general: "",
        duringSemester: "",
        exam: "",
        year: new Date().getFullYear(),
        semester: "",
      }));
  
      setIsModalOpen(false);
      setShowSuggestions(false);
    } catch (err) {
      alert(`Hiba történt: ${err.message}`);
    }
  };

  // --- A fő lista (keresés + félév)
  const filteredSubjects = subjects.filter((subject) => {
    const normSearch = removeAccents(searchTerm.toLowerCase());
    const normName = removeAccents(subject.name.toLowerCase());
    const matchesSearch = normName.includes(normSearch);

    const matchesSemester =
      selectedSemester === "all" ||
      subject.semester === parseInt(selectedSemester, 10);

    return matchesSearch && matchesSemester;
  });

  if (loading) return <p>Adatok betöltése...</p>;
  if (error) return <p>Hiba történt: {error}</p>;

  return (
    <div className="subject-info-container">
      {/* Keresés, félév */}
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
        <button className="open-modal-button" onClick={() => setIsModalOpen(true)}>
          Feltöltés
        </button>
      </div>

      {/* Megjelenített subjectek */}
      {filteredSubjects.length > 0 ? (
        filteredSubjects
          .reduce((acc, s) => {
            const existing = acc.find((item) => item.name === s.name);

            if (existing) {
              if (s.user && s.user !== "N/A" && s.user.trim() !== "") {
                existing.users.push({
                  user: s.user,
                  user_id: s.user_id,
                  year: s.year,
                  difficulty: s.difficulty,
                  general: s.general,
                  duringSemester: s.duringSemester,
                  exam: s.exam,
                  id: s.id,
                });
              }
            } else {
              acc.push({
                name: s.name,
                semester: s.semester,
                id: s.id,
                users:
                  s.user && s.user !== "N/A" && s.user.trim() !== ""
                    ? [
                        {
                          user: s.user,
                          user_id: s.user_id,
                          year: s.year,
                          difficulty: s.difficulty,
                          general: s.general,
                          duringSemester: s.duringSemester,
                          exam: s.exam,
                          id: s.id,
                        },
                      ]
                    : [],
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
                                  openEditModal({
                                    ...u,
                                    id: u.id,
                                    name: group.name,
                                    semester: group.semester,
                                  })
                                }
                              >
                                Szerkesztés
                              </button>
                              <button
                                className="delete-button"
                                onClick={() => handleDelete(u.id)}
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
                        {u.general && <p><strong>Általános:</strong> {u.general}</p>}
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
                {/* Csak akkor jelenítjük meg az extra elemet, ha a tárgy neve nem "Általános info" */}
                {group.name !== "Általános info" && (
                  <div className="user-feedback write-review">
                    <p>
                      Írj véleményt{" "}
                      <button
                        className="write-review-button"
                        onClick={() => openModalForSubject(group.name, group.semester)}
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

      {/* Modal: Új vélemény */}
      {isModalOpen && (
        <div className="modal-overlay" onClick={handleModalClose}>
          <div className="modal-content">
            <button
              className="close-button"
              onClick={() => {
                setIsModalOpen(false);
                setNewEntry((prev) => ({
                  ...prev,
                  name: "",
                  difficulty: "",
                  general: "",
                  duringSemester: "",
                  exam: "",
                  year: new Date().getFullYear(),
                  semester: "",
                }));
                setEditingReviewId(null);
                setShowSuggestions(false);
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
                  placeholder="Szám (0-10) "
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
