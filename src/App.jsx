import React, { useState, useEffect } from 'react';
import './App.css';
import FolderManager from './FolderManager'; // Importáljuk az osztályt
import Home from './Home'; // Import the Home component
import UniversityLinks from './UniversityLinks.jsx';
import OthersLinks from './OthersLinks.jsx';
import About from './About.jsx';
import SubjectInfo from './SubjectInfo.jsx'; // Import the updated SubjectInfo


const App = () => {
  const [darkMode, setDarkMode] = useState(true);
  const [content, setContent] = useState('home');
  const [folders, setFolders] = useState([]); // A mappák tárolása
  const [currentPath, setCurrentPath] = useState('/PPKE'); // Jelenlegi útvonal

  const folderManager = new FolderManager('/api/files');

  const toggleDarkMode = () => {
    setDarkMode((prevMode) => !prevMode); // Dark Mode váltás
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
        <h1>bakan7</h1>
        <button
          className="theme-toggle"
          onClick={toggleDarkMode}
        >
          {darkMode ? '🌙' : '🌞'}
        </button>
      </header>

      <nav className="navbar">
        <ul className="menu">
          <li><a href="#" className="button" onClick={() => handleMenuClick('home')}>Főoldal</a></li>
          <li className="dropdown">
            <a href="#" className="button" onClick={() => handleMenuClick('subjects')}>Tárgy info</a>
          </li>
          <li>
            <a href="#" className="button" onClick={() => setContent('info')}>
              Egyetemi Linkek
            </a>
          </li>
          <li><a href="#" className="button" onClick={() => handleMenuClick('othersLink')}>Mások oldalai</a></li>
          <li><a href="#" className="button" onClick={() => handleMenuClick('about')}>Kapcsolat</a></li>
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
        {content === 'subjects' &&  <SubjectInfo />} {/* Tárgyakról leírás */}
        {content === 'info' && <UniversityLinks />} {/* Egyetemi Linkek */}
        {content === 'othersLink' && <OthersLinks />} {/* Masok oldalai */}
        {content === 'about' && <About />} {/* Kapcsolat */}
      </div>
    </div>
  );
};

export default App;
