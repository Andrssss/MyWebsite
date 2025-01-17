import React from 'react';

const Home = ({ folders, currentPath, handleMenuClick, setCurrentPath }) => {
  const folderId = '1V4ryxSmLNoQZ14UQry1DbfjUlVWN6DTx'; // Cseréld ki a Google Drive mappád azonosítójára
  const embedLink = `https://drive.google.com/embeddedfolderview?id=${folderId}#grid`;

  return (
    <div>
      {/* Iframe a mappa tartalmának megjelenítéséhez */}
      <div >
        
        <iframe
          src={embedLink}
          style={{
            width: '100%',
            height: '500px',
            border: 'none',
          }}
        ></iframe>
      </div>
    </div>
  );
};

export default Home;
