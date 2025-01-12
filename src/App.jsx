import React, { useState, useEffect } from 'react';
import './App.css';
import FolderManager from './FolderManager'; // Importáljuk az osztályt
import Home from './Home'; // Import the Home component

const App = () => {
  const [darkMode, setDarkMode] = useState(true);
  const [content, setContent] = useState('home');
  const [folders, setFolders] = useState([]); // A mappák tárolása
  const [currentPath, setCurrentPath] = useState('/PPKE'); // Jelenlegi útvonal

  const folderManager = new FolderManager('/api/files');

  const toggleDarkMode = () => {
    console.log("Dark mode toggled");
    setDarkMode(!darkMode);
  };

  const handleMenuClick = async (menu, path = '/PPKE') => {
    console.log('Menu:', menu, 'Path:', path);
    try {
      setContent(menu);
      if (menu === 'home') {
        const loadedFolders = await folderManager.getFolders(path);
        setFolders(loadedFolders);
        setCurrentPath(path); // Állítsuk be az aktuális útvonalat
      }
    } catch (error) {
      console.error(error);
      alert("Hiba történt a mappák betöltésekor.");
    }
  };

  // Főoldal mappáinak betöltése az induláskor
  useEffect(() => {
    handleMenuClick('home');
  }, []); // Csak egyszer fusson le, amikor a komponens betöltődik

  return (
    <div className={`container ${darkMode ? 'dark-mode' : ''}`}>
      <header className="header">
        <h1>Bakó András</h1>
        <p>Egyetemi Honlapja</p>
        <button className="theme-toggle" onClick={toggleDarkMode}>
          {darkMode ? '🌙' : '🌞'}
        </button>
      </header>

      <nav className="navbar">
        <ul className="menu">
          <li><a href="#" className="button" onClick={() => handleMenuClick('home')}>Főoldal</a></li>
          <li><a href="#" className="button" onClick={() => handleMenuClick('university')}>Haszna</a></li>
          <li className="dropdown">
            <a href="#" className="button" onClick={() => handleMenuClick('subjects')}>Tárgy info</a>
            <ul className="dropdown-menu">
              <li><a href="#" className="button" onClick={() => handleMenuClick('semester1')}>1. félév</a></li>
              <li><a href="#" className="button" onClick={() => handleMenuClick('semester2')}>2. félév</a></li>
              <li><a href="#" className="button" onClick={() => handleMenuClick('semester3')}>3. félév</a></li>
              <li><a href="#" className="button" onClick={() => handleMenuClick('semester4')}>4. félév</a></li>
              <li><a href="#" className="button" onClick={() => handleMenuClick('semester5')}>5. félév</a></li>
              <li><a href="#" className="button" onClick={() => handleMenuClick('semester6')}>6. félév</a></li>
              <li><a href="#" className="button" onClick={() => handleMenuClick('semester7')}>7. félév</a></li>
            </ul>
          </li>
          <li><a href="#" className="button" onClick={() => handleMenuClick('info')}>Egyetemi Linkek</a></li>
          <li><a href="#" className="button" onClick={() => handleMenuClick('about')}>Mások oldalai</a></li>
        </ul>
      </nav>

      <div className="content">
        {content === 'home' && (
          <Home
            folders={folders}
            currentPath={currentPath}
            handleMenuClick={handleMenuClick}
            setCurrentPath={setCurrentPath}
          />
        )}
        {content === 'university' && <div>Egyetemi honlap tartalom</div>}
        {content === 'subjects' && <div>Tárgy info</div>}
        {content === 'info' && <div>Tudnivalók tartalom</div>}
        {content === 'about' && <div>Rólam tartalom</div>}
      </div>

      <aside className="sidebar">
        <div className="search-container">
          <input type="text" placeholder="Keresés ..." />
        </div>
        <h3>Legutóbbi bejegyzések</h3>
        <ul>
          <li><a href="#" className="bionika-link">6. félév a bionikán</a></li>
          <li><a href="#" className="bionika-link">7. félév a bionikán</a></li>
        </ul>
      </aside>
    </div>
  );
};

export default App;
