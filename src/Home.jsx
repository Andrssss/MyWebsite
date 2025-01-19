import React, { useState, useEffect } from 'react';

const Home = ({ folders, currentPath, handleMenuClick, setCurrentPath }) => {
  const folderId = '1V4ryxSmLNoQZ14UQry1DbfjUlVWN6DTx'; // Cseréld ki a Google Drive mappád azonosítójára
  const embedLink = `https://drive.google.com/embeddedfolderview?id=${folderId}#grid`;

  // Hook a képernyő szélességének figyelésére
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth <= 768); // Beállítja, ha mobil képernyő
    };

    // Inicializálás
    handleResize();

    // Eseményfigyelő hozzáadása
    window.addEventListener('resize', handleResize);

    // Takarítás
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  return (
    <div
      style={{
        width: '110%',
        height: '90vh', // Ensures full viewport height for iframe
        marginLeft: isMobile ? '-10%' : '0', // Ha mobil, akkor -10% margó, különben nincs margó
        marginTop: isMobile ? '-4%' : '0',
      }}
    >
      <iframe
        src={embedLink}
        style={{
          width: '110%', // Teljes szélesség
          height: '100%', // Teljes magasság
          border: 'none',
          overflow: 'hidden',
        }}
      ></iframe>
    </div>
  );
};

export default Home;