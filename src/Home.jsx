import React, { useState, useEffect } from 'react';

const Home = ({ folders, currentPath, handleMenuClick, setCurrentPath }) => {
  const folderId = '1V4ryxSmLNoQZ14UQry1DbfjUlVWN6DTx'; // Cseréld ki a Google Drive mappád azonosítójára
  const embedLink = `https://drive.google.com/embeddedfolderview?id=${folderId}#grid`;

  // Hook a képernyő szélességének figyelésére
  const [isMobile, setIsMobile] = useState(false);
  // Állapot a betöltés nyomon követésére
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth <= 768);
    };

    handleResize();
    window.addEventListener('resize', handleResize);

    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Az iframe betöltésekor hívódik meg
  const handleIframeLoad = () => {
    setLoading(false);
  };

  return (
    <div
      style={{
        width: '110%',
        height: '90vh',
        marginLeft: isMobile ? '-10%' : '0',
        marginTop: isMobile ? '-4%' : '0',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {loading && (
        <div
          style={{
            position: 'fixed', // Fixed pozícionálás a viewport közepén
            top: 0,
            left: 0,
            width: '100vw',
            height: '100vh',
            zIndex: 9999,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '1.5rem',
          }}
        >
          Betöltés...
        </div>
      )}
      <iframe
        src={embedLink}
        onLoad={handleIframeLoad}
        style={{
          width: '110%',
          height: '100%',
          border: 'none',
          overflow: 'hidden',
        }}
      ></iframe>
    </div>
  );
};

export default Home;
