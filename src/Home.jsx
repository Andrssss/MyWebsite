import React, { useState, useEffect } from 'react';

const Home = ({ setContent, setMenuOpen }) => {
  const folderId = '1V4ryxSmLNoQZ14UQry1DbfjUlVWN6DTx'; 
  const embedLink = `https://drive.google.com/embeddedfolderview?id=${folderId}#grid`;

  const [isMobile, setIsMobile] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth <= 768);
    };

    handleResize();
    window.addEventListener('resize', handleResize);

    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const handleIframeLoad = () => {
    setLoading(false);
  };

  return (
    <div>
          <div className="about-container" 
        style={{ 
          padding: '20px', 
          textAlign: 'center', 
          backgroundColor: '#f8f8f8', 
          marginBottom: '0px', 
          zIndex: 500,
          position: 'relative' // szükséges, hogy a z-index működjön
        }}>
      <h2>
        Gyere te is írj vagy olvass véleményt a 
        <a href="#" className="button" onClick={() => { setContent('subjects'); setMenuOpen(false); }}>
          Tárgy info-n
        </a>
        !
      </h2>
    </div>


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
              position: 'fixed',
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
    </div>
  );
};

export default Home;
