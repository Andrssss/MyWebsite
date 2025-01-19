import React from 'react';

const Home = ({ folders, currentPath, handleMenuClick, setCurrentPath }) => {
  const folderId = '1V4ryxSmLNoQZ14UQry1DbfjUlVWN6DTx'; // Cseréld ki a Google Drive mappád azonosítójára
  const embedLink = `https://drive.google.com/embeddedfolderview?id=${folderId}#grid`;

  return (
    <div
      style={{
        width: '90%', // Csökkentett szélesség
        height: '80vh', // Csökkentett magasság
        margin: '0 auto', // Központosítás
        padding: '70px', // Csökkentett térköz a tartalom körül
        paddingTop: '0px'

        // Ha még közelebb szeretnéd a fejléchez, csökkentheted a padding-top-ot is
      }}
    >
      <iframe
        src={embedLink}
        style={{
          width: '120%', // Teljes szélesség a div-en belül
          height: '120%', // Teljes magasság a div-en belül
          border: 'none',
          overflow: 'hidden',
        }}
      ></iframe>
    </div>
  );
};

export default Home;
