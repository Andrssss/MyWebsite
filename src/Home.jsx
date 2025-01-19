import React from 'react';

const Home = ({ folders, currentPath, handleMenuClick, setCurrentPath }) => {
  const folderId = '1V4ryxSmLNoQZ14UQry1DbfjUlVWN6DTx'; // Cseréld ki a Google Drive mappád azonosítójára
  const embedLink = `https://drive.google.com/embeddedfolderview?id=${folderId}#grid`;

  return (
    <div
      style={{
        width: '110%',
        height: '90vh', // Ensures full viewport height for iframe
        marginLeft: '-10%', // Balra tolás, pl. -10% -kal

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
