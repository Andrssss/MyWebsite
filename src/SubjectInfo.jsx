import "./SubjectInfo.css";
import React, { useState, useEffect } from "react";

// Ékezetmentesítés
const removeAccents = (str) =>
  str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

const SubjectInfo = () => {
  const [subjects, setSubjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

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
    const fetchTable = async () => {
      try {
        const response = await fetch("https://www.kacifant.hu/andris/test.php");
        if (!response.ok) {
          throw new Error("Nem sikerült betölteni az adatokat");
        }
        const html = await response.text();
        setSubjects(parseHTMLTable(html));
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };

    // Ha van mentett user
    const savedUserName = localStorage.getItem("savedUserName");
    if (savedUserName) {
      setNewEntry((prev) => ({ ...prev, user: savedUserName }));
    }

    fetchTable();
  }, []);

  const parseHTMLTable = (html) => {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    const rows = doc.querySelectorAll("table tr");

    const arr = [];
    rows.forEach((row, index) => {
      if (index === 0) return; // fejléc
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
      });
    });
    return arr;
  };

  // --- Keresés + félév szűrés
  const handleSemesterChange = (e) => {
    setSelectedSemester(e.target.value);
    setSearchTerm("");
  };

  // Ha a felhasználó ír valamit a keresőmezőbe,
  // és NEM üres a kifejezés, automatikusan all-ra állítjuk a félévet:
  const handleSearchTermChange = (e) => {
    const val = e.target.value;
    setSearchTerm(val);

    // Ha van beírt szöveg, levesszük a félévszűrést
    if (val.trim().length > 0) {
      setSelectedSemester("all");
    }
  };

  // =========== AUTOCOMPLETE LOGIKA ===========
  // 1) onFocus => mindig mutassa az összes tárgyat
  const handleNameFocus = () => {
    // Összes tárgynév, egyedivé téve
    const allNames = [...new Set(subjects.map((subj) => subj.name))].sort((a, b) =>
      a.localeCompare(b)
    );
    setSuggestions(allNames);
    setShowSuggestions(true);
  };

  // 2) OnChange => ha üres, mutasson mindent, ha van szöveg, szűrjön
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
  
    // === IDE írd a beillesztendő kódot, a logika végére: ===
  
    // Ha a beírt value (szóközöket levéve) pontosan egyezik egy subject.name mezővel,
    // akkor automatikusan állítsuk be a semester mezőt is.
    const exactMatch = subjects.find((s) => s.name === value.trim());
    if (exactMatch) {
      setNewEntry((prev) => ({
        ...prev,
        semester: exactMatch.semester,
      }));
    }
  };
  





  // Kattintás egy javaslatra
  const handleSuggestionClick = (suggestedName) => {
    // Keresd meg a subjects tömbben
    const foundSubject = subjects.find((s) => s.name === suggestedName);
  
    if (foundSubject) {
      // Ha megtaláltad, beállítod a name és a semester mezőt is
      setNewEntry((prev) => ({
        ...prev,
        name: suggestedName,
        semester: foundSubject.semester,
      }));
    } else {
      // Ha véletlen nem találtad (pl. duplán van?), egyszerű fallback
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
  };

  const handleSubmit = async (e) => {
    e.preventDefault();



    if (newEntry.difficulty.trim() !== "") {
      const d = parseInt(newEntry.difficulty, 10);
      if (isNaN(d)) {
        alert("A nehézség mezőnek számot kell tartalmaznia !");
        return; // Megszakítjuk a submitot
      }
    }

    // Megnézzük, létezik-e az adott tárgy:
    const foundSubject = subjects.find((s) => s.name === newEntry.name.trim());
    if (!foundSubject) {
      alert("Nincs ilyen tárgy a meglévő listában!");
      return; // Megszakítjuk a submitot
    }

    if (!newEntry.user) {
      newEntry.user = "anonim";
    }


    const isNameEmpty = !newEntry.name.trim(); // üres a tárgynév
    const isUserAnon = !newEntry.user.trim() || newEntry.user.trim().toLowerCase() === "anonim";
    const isDifficultyEmpty = !newEntry.difficulty.trim();
    const isGeneralEmpty = !newEntry.general.trim();
    const isDuringEmpty = !newEntry.duringSemester.trim();
    const isExamEmpty = !newEntry.exam.trim();
    if (
      isDifficultyEmpty &&
      isGeneralEmpty &&
      isDuringEmpty &&
      isExamEmpty
    ) {
      alert("Minden mezőt üresen hagytál, tölts ki legalább egyet!");
      return; // Megszakítjuk a beküldést
    }
  
  

    const formData = new URLSearchParams();
    Object.keys(newEntry).forEach((key) => formData.append(key, newEntry[key]));

    formData.set("semester", foundSubject.semester);



    try {
      const response = await fetch("https://www.kacifant.hu/andris/submit.php", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        },
        body: formData.toString(),
      });

      if (!response.ok) {
        throw new Error("Hiba történt az adatbeküldés során");
      }
      alert("Adatok sikeresen beküldve!");
      // Reset
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
        {/* FONTOS: itt cseréltük le onChange-t a handleSearchTermChange-re */}
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
            if (s.user && s.user !== "N/A" && s.user.trim() !== "") {
              if (existing) {
                existing.users.push({
                  user: s.user,
                  year: s.year,
                  difficulty: s.difficulty,
                  general: s.general,
                  duringSemester: s.duringSemester,
                  exam: s.exam,
                });
              } else {
                acc.push({
                  name: s.name,
                  semester: s.semester,
                  users: [
                    {
                      user: s.user,
                      year: s.year,
                      difficulty: s.difficulty,
                      general: s.general,
                      duringSemester: s.duringSemester,
                      exam: s.exam,
                    },
                  ],
                });
              }
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
                    <h4>{u.user}</h4>
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
                  </div>
                ))}
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
                setShowSuggestions(false);
              }}
            >
              x
            </button>
            <form onSubmit={handleSubmit} className="submission-form">
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

                {/* Javaslatok doboza */}
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
                <label htmlFor="user">Felhasználó:</label>
                <input
                  type="text"
                  id="user"
                  name="user"
                  value={newEntry.user}
                  onChange={handleInputChange}
                />
              </div>

              <div className="form-group">
                <label htmlFor="difficulty">Nehézség: (1-10)</label>
                <input
                  type="text"
                  id="difficulty"
                  name="difficulty"
                  value={newEntry.difficulty}
                  onChange={handleInputChange}
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
                ></textarea>
              </div>

              <div className="form-group">
                <label htmlFor="exam">Vizsga:</label>
                <textarea
                  id="exam"
                  name="exam"
                  value={newEntry.exam}
                  onChange={handleInputChange}
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
