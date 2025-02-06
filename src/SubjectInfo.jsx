import "./SubjectInfo.css";
import React, { useState, useEffect } from "react";

const removeAccents = (str) => str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

const SubjectInfo = () => {
  const [subjects, setSubjects] = useState([]); // Tárolja a feldolgozott tárgyakat
  const [loading, setLoading] = useState(true); // Betöltési állapot
  const [error, setError] = useState(null); // Hiba állapot
  const [searchTerm, setSearchTerm] = useState(""); // Keresési mező
  const [selectedSemester, setSelectedSemester] = useState("all"); // Félév szűrő
  const [isModalOpen, setIsModalOpen] = useState(false); // Pop-up ablak állapota
  const [newEntry, setNewEntry] = useState({
    name: "",
    user: "anonim", // Alapértelmezetten anonim
    difficulty: "",
    general: "",
    duringSemester: "",
    exam: "",
    year: new Date().getFullYear(), // Alapértelmezett év: idei
    semester: "",
  });

  // Esemény a modal bezárásához
  const handleModalClose = (e) => {
    // Ha a háttérre kattintottak, akkor zárjuk be a modalt
    if (e.target.className === "modal-overlay") {
      setIsModalOpen(false);
    }
  };

  useEffect(() => {
    const fetchTable = async () => {
      try {
        const response = await fetch("https://www.kacifant.hu/andris/test.php");
        if (!response.ok) {
          throw new Error("Nem sikerült betölteni az adatokat");
        }
        const html = await response.text();
        const parsedSubjects = parseHTMLTable(html); // HTML átalakítása JSON-re
        setSubjects(parsedSubjects);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };

    // Betöltjük a mentett nevet, ha van
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

    const subjectsArray = [];
    rows.forEach((row, index) => {
      if (index === 0) return; // Fejléc kihagyása
      const cells = row.querySelectorAll("td");

      subjectsArray.push({
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
    return subjectsArray;
  };

  const handleSemesterChange = (e) => {
    setSelectedSemester(e.target.value);
    setSearchTerm(""); // Töröljük a keresési kifejezést
  };

  const handleInputChange = (e) => {
      const { name, value } = e.target;
    
      setNewEntry((prev) => {
        if (name === "name") {
          const selectedSubject = subjects.find((subject) => subject.name === value);
          return {
            ...prev,
            [name]: value,
            semester: selectedSubject ? selectedSubject.semester : "", // Beállítjuk a félévet
          };
        }
        return { ...prev, [name]: value };
      });
    
      if (name === "user") {
        localStorage.setItem("savedUserName", value);
      }
    };
  
  

  const handleSubmit = async (e) => {
    e.preventDefault();



    // Létrehozunk egy FormData objektumot, amivel elküldjük a form adatokat
    const formData = new URLSearchParams();
    Object.keys(newEntry).forEach((key) => formData.append(key, newEntry[key]));




    // Ha a felhasználó nem adott meg nevet, alapértelmezetten "anonim"
    if (!newEntry.user) {
      newEntry.user = "anonim";
    }

    try {
      const response = await fetch("https://www.kacifant.hu/andris/submit.php", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        },
        body: formData.toString(), // URL-encoded adatok

      });

      if (!response.ok) {
        throw new Error("Hiba történt az adatbeküldés során");
      }
      const responseData = await response.text();
      alert("Adatok sikeresen beküldve!");

      // Csak azokat a mezőket állítjuk vissza, amelyek nem a "user" mező
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
      setIsModalOpen(false); // Pop-up bezárása
    } catch (err) {
      alert(`Hiba történt: ${err.message}`);
    }
  };

  const filteredSubjects = subjects.filter((subject) => {
    const normalizedSearchTerm = removeAccents(searchTerm.toLowerCase());
    const normalizedSubjectName = removeAccents(subject.name.toLowerCase());

    const matchesSearch = normalizedSubjectName.includes(normalizedSearchTerm);
    const matchesSemester =
      selectedSemester === "all" || subject.semester === parseInt(selectedSemester, 10);

    return searchTerm ? matchesSearch : matchesSemester;
  });

  if (loading) {
    return <p>Adatok betöltése...</p>;
  }

  if (error) {
    return <p>Hiba történt: {error}</p>;
  }

  return (
    <div className="subject-info-container">
      <div className="search-filter-container">
        <input
          type="text"
          placeholder="Keresés tárgy neve alapján..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="search-bar"
        />
        <select
          value={selectedSemester}
          onChange={handleSemesterChange}
          className="semester-filter"
        >
          <option value="all">Összes félév</option>
          {[...new Set(subjects.map((s) => s.semester))].filter((semester) => semester !== "N/A").sort((a, b) => a - b).map((semester) => (
            <option key={semester} value={semester}>
              {semester}. FÉLÉV
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

      {filteredSubjects.length > 0 ? (
        filteredSubjects
          .reduce((acc, subject) => {
              const existingSubject = acc.find((item) => item.name === subject.name);
              if (subject.user && subject.user.trim() !== "" && subject.user !== "N/A") { // Csak akkor adja hozzá, ha van user
                if (existingSubject) {
                  existingSubject.users.push({
                    user: subject.user,
                    year: subject.year,
                    difficulty: subject.difficulty,
                    general: subject.general,
                    duringSemester: subject.duringSemester,
                    exam: subject.exam,
                  });
                } else {
                  acc.push({
                    name: subject.name,
                    semester: subject.semester,
                    users: [
                      {
                        user: subject.user,
                        year: subject.year,
                        difficulty: subject.difficulty,
                        general: subject.general,
                        duringSemester: subject.duringSemester,
                        exam: subject.exam,
                      },
                    ],
                  });
                }
            }
            return acc;
          }, [])
          .map((subject, index) => (
            <div key={index} className="subject-card">
              <div className="subject-header">
                <h3 className="subject-title">{subject.name}</h3>
              </div>
              <div className="subject-semester">
                <p>Félév: {subject.semester}. FÉLÉV</p>
              </div>
              <div className="subject-details">
                {subject.users.map((user, userIndex) => (
                  <div key={userIndex} className="user-feedback">
                    <h4>{user.user}</h4>
                    <p><strong>Év:</strong> {user.year}</p>
                    {user.difficulty !== "N/A" && (
                      <p><strong>Nehézség: </strong> {user.difficulty}/10</p>
                    )}
                    {user.general && (
                      <p><strong>Általános:</strong> {user.general}</p>
                    )}
                    {user.duringSemester !== "N/A" && (
                      <p><strong>Évközben:</strong> {user.duringSemester}</p>
                    )}
                    {user.exam !== "N/A" && (
                      <p><strong>Vizsga:</strong> {user.exam}</p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))
      ) : (
        <p className="no-results">Nincs találat a keresett kifejezésre.</p>
      )}

      {/* Pop-up modal */}
      {isModalOpen && (
        <div className="modal-overlay" onClick={handleModalClose}>
          <div className="modal-content">
            <button
              className="close-button"
              onClick={() => setIsModalOpen(false)}
            >
              x
            </button>
            <form onSubmit={handleSubmit} className="submission-form">
              <h2>Új vélemény hozzáadása</h2>

              {/* Tárgynév */}
              <div className="form-group">
                <label htmlFor="name">Tárgynév:</label>
                <select
                  id="name"
                  name="name"
                  value={newEntry.name}
                  onChange={handleInputChange}
                  required
                >
                  <option value="">Válassz egy tárgyat</option>
                  {subjects
                  .slice() // Másolatot készítünk a biztonság kedvéért
                  .sort((a, b) => a.name.localeCompare(b.name)) // ABC sorrendbe rendezzük a nevek alapján
                  .map((subject, index) => (
                    <option key={index} value={subject.name}>
                      {subject.name}
                    </option>
                  ))}
                </select>
              </div>

              {/* Felhasználó */}
              <div className="form-group">
                <label htmlFor="user">Felhasználó:</label>
                <input
                  type="text"
                  id="user"
                  name="user"
                  value={newEntry.user}
                  onChange={handleInputChange}
                  placeholder="Írd be a nevet vagy hagyd üresen"
                />
              </div>

              {/* Nehézség */}
              <div className="form-group">
                <label htmlFor="difficulty">Nehézség: (1-10)</label>
                <input
                  type="text"
                  id="difficulty"
                  name="difficulty"
                  value={newEntry.difficulty}
                  onChange={handleInputChange}
                  placeholder="Írd be a nehézséget"
                />
              </div>

              {/* Általános */}
              <div className="form-group">
                <label htmlFor="general">Általános:</label>
                <textarea
                  id="general"
                  name="general"
                  value={newEntry.general}
                  onChange={handleInputChange}
                ></textarea>
              </div>

              {/* Évközben */}
              <div className="form-group">
                <label htmlFor="duringSemester">Évközben: (nem kötelező)</label>
                <textarea
                  id="duringSemester"
                  name="duringSemester"
                  value={newEntry.duringSemester}
                  onChange={handleInputChange}
                ></textarea>
              </div>

              {/* Vizsga */}
              <div className="form-group">
                <label htmlFor="exam">Vizsga: (nem kötelező)</label>
                <textarea
                  id="exam"
                  name="exam"
                  value={newEntry.exam}
                  onChange={handleInputChange}
                ></textarea>
              </div>

              {/* Év */}
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
