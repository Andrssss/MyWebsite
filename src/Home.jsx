import React, { useState, useEffect } from 'react';

const Home = () => {
  // Mobilnézet figyelése
  const [isMobile, setIsMobile] = useState(false);
  // Kiválasztott mappa ID
  const [selectedFolderId, setSelectedFolderId] = useState(null);
  // Betöltési állapot (csak akkor igaz, ha az iframe még töltődik)
  const [iframeLoaded, setIframeLoaded] = useState(false);

  const folders = [
    { name: '1. FÉLÉV', id: '15GaVm9O4usLBA7oBE9q0LHp0VyBdzTNZ' },
    { name: '2. FÉLÉV', id: '17ZNNYjsdRlWOMY1Sib0ckboxlWtPGAOT' },
    { name: '3. FÉLÉV', id: '1qADHXKHCW4VbCu2paVo_FyV_FYkvH-Ta' },
    { name: '4. FÉLÉV', id: '1kLok9xiP5f-suibWluwykDZlqoP0k8r7' },
    { name: '5. FÉLÉV', id: '1EQWAV93Cg_9XAOGS8M2R7A-2QAGqXu8x' },
    { name: '6. FÉLÉV', id: '1qYv5d6DLZqpZumIqRo776POMoxXXRRuS' },
    { name: '7. FÉLÉV', id: '1-O2jAYW9joUIWJNU6Rx4L1QKpueezVKA' },
    { name: 'SZUM', id: '1en60jQdJpmYqt05vQwOoX-fDnaij-k9X' },
  ];

  // Ablakméret figyelése
  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth <= 768);
    };
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Amikor új mappát választunk, visszaállítjuk a loading állapotot
  useEffect(() => {
    if (selectedFolderId) {
      setIframeLoaded(false);
    }
  }, [selectedFolderId]);

  // Stílusok
  const styles = {
    gridContainer: {
      display: 'flex',
      flexWrap: 'wrap',
      gap: '2rem',
      justifyContent: 'center',
      marginTop: '2rem',
    },
    folderItem: {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      cursor: 'pointer',
      textDecoration: 'none',
      color: 'inherit',
    },
    iconPlaceholder: {
      fontSize: '3rem',
    },
    iframeContainer: {
      width: '110%',
      height: '90vh', // Teljes viewport magasság
      marginLeft: isMobile ? '-10%' : '0', // Mobil esetén -10% margó, különben 0
      marginTop: isMobile ? '-4%' : '0',
      position: 'relative',
    },
    iframeStyle: {
      width: '110%', // Teljes szélesség
      height: '100%', // Teljes magasság
      border: 'none',
      overflow: 'hidden',
    },
    backButton: {
      margin: '1rem',
      padding: '0.5rem 1rem',
      cursor: 'pointer',
      fontSize: '1rem',
    },
    loader: {
      position: 'absolute',
      top: '10%', // Fentre igazítva
      left: '50%',
      transform: 'translateX(-50%)',
      fontSize: '1.5rem',
      fontWeight: 'bold',
      display: 'flex',
      alignItems: 'center',
      gap: '0.5rem',
    },
  };

  // Ha már kiválasztottunk egy mappát, építsük fel az embed linket (mind mobil, mind asztali esetén)
  if (selectedFolderId) {
    const embedLink = `https://drive.google.com/embeddedfolderview?id=${selectedFolderId}#grid`;

    return (
      <div style={styles.iframeContainer}>
        <button style={styles.backButton} onClick={() => setSelectedFolderId(null)}>
          Vissza
        </button>
        {!iframeLoaded && (
          <div style={styles.loader}>
            <span role="img" aria-label="Betöltés">⏳</span>
            Betöltés...
          </div>
        )}
        <iframe
          src={embedLink}
          style={styles.iframeStyle}
          title="Félév Drive"
          onLoad={() => setIframeLoaded(true)}
        ></iframe>
      </div>
    );
  }

  // Mobil nézet: listázva, a túlméretezett iframe stílusok megtartása mellett
  if (isMobile) {
    return (
      <>
        <div className="university-links">
          <ul className="university-links-list">
            {folders.map((folder, index) => (
              <li key={index}>
                <button
                  className="university-link-button"
                  onClick={() => setSelectedFolderId(folder.id)}
                >
                  📂 {folder.name}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </>
    );
  }

  // Nem mobil nézet: grid elrendezés
  return (
    <div style={styles.gridContainer}>
      {folders.map((folder) => (
        <div
          key={folder.id}
          style={styles.folderItem}
          onClick={() => setSelectedFolderId(folder.id)}
        >
          <div style={styles.iconPlaceholder}>📂</div>
          <span>{folder.name}</span>
        </div>
      ))}
    </div>
  );
};

export default Home;
