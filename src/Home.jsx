import React from 'react';

const Home = ({ folders, currentPath, handleMenuClick, setCurrentPath }) => {
  const folderId = '1V4ryxSmLNoQZ14UQry1DbfjUlVWN6DTx'; // Cseréld ki a Google Drive mappád azonosítójára
  const embedLink = `https://drive.google.com/embeddedfolderview?id=${folderId}#grid`;

  return (
    <div
      style={{
        width: '100%',
        height: '100vh', // Ensures full viewport height for iframe
        overflow: 'hidden', // Prevent scrollbars on the container
      }}
    >
      <iframe
        src={embedLink}
        style={{
          width: '105%',
          height: '100%',
          border: 'none',
        }}
      ></iframe>
    </div>
  );
};

export default Home;
