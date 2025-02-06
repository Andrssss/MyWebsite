import "./SubjectInfo.css";

import React, { useState, useEffect } from "react";

const SubjectInfo = () => {
  const [tableHTML, setTableHTML] = useState(""); // Tárolja a HTML tartalmat
  const [loading, setLoading] = useState(true); // Betöltési állapot
  const [error, setError] = useState(null); // Hiba állapot

  useEffect(() => {
    const fetchTable = async () => {
      try {
        const response = await fetch("https://www.kacifant.hu/andris/test.php", {
          method: "GET",
          headers: {
            "Content-Type": "text/html", // Megfelelő tartalomtípus
          },
        });
        if (!response.ok) {
          throw new Error("Nem sikerült betölteni az adatokat");
        }
        const html = await response.text(); // Válasz feldolgozása szövegként
        setTableHTML(html); // HTML tárolása
      } catch (err) {
        setError(err.message); // Hiba beállítása
      } finally {
        setLoading(false); // Betöltés vége
      }
    };

    fetchTable();
  }, []);

  if (loading) {
    return <p>Adatok betöltése...</p>;
  }

  if (error) {
    return <p>Hiba történt: {error}</p>;
  }

  return (
    <div>
      {/* HTML beszúrás */}
      <div dangerouslySetInnerHTML={{ __html: tableHTML }} />
    </div>
  );
};

export default SubjectInfo;
