import React from 'react';

const Home = ({ folders, currentPath, handleMenuClick, setCurrentPath }) => {
  return (
    <div>
      {/* "Fel" gomb csak akkor látszik, ha nem az alapútvonalon vagyunk */}
      {currentPath !== '/PPKE' && (
        <button
          onClick={() => {
            const parentPath = currentPath.substring(0, currentPath.lastIndexOf('/'));
            handleMenuClick('home', parentPath);
            setCurrentPath(parentPath);
          }}
        >
          📂 Fel
        </button>
      )}
      <ul>
        {folders.map((folder, index) => (
          <li key={index} style={{ display: 'flex', alignItems: 'center' }}>
            {folder.type === 'folder' ? (
              <>
                <button
                  onClick={() => handleMenuClick('home', `${currentPath}/${folder.name}`)}
                  className="folder-button"
                >
                  📂 {folder.name}
                </button>
                <button
                  onClick={() =>
                    window.location.href = `http://localhost:5000/api/download?path=${currentPath}/${folder.name}`
                  }
                  style={{ marginLeft: '10px' }}
                >
                  Letöltés
                </button>
              </>
            ) : (
              <>
                <span className="file-icon">
                  {folder.name.endsWith('.mp4') 
                    ? '▶️' 
                    : folder.name.endsWith('.ppt') 
                      ? '📙' 
                      : folder.name.endsWith('.jpg') || folder.name.endsWith('.png') || folder.name.endsWith('.PNG') || folder.name.endsWith('.JPG')
                        ? '🌇' 
                        : '📄'} 
                  {folder.name}
                </span>
                <button
                  onClick={() =>
                    window.location.href = `http://localhost:5000/api/download?path=${currentPath}/${folder.name}`
                  }
                  style={{ marginLeft: '10px' }}
                >
                  Letöltés
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
};

export default Home;
