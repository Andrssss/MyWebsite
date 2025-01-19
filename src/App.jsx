import React, { useState, useEffect } from 'react';
import './App.css';
import Home from './Home';
import UniversityLinks from './UniversityLinks.jsx';
import OthersLinks from './OthersLinks.jsx';
import About from './About.jsx';
import SubjectInfo from './SubjectInfo.jsx';
import Particles from './Particles.jsx';

const App = () => {
  const [content, setContent] = useState('home');
  const [menuOpen, setMenuOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth <= 650);
    };

    handleResize(); // Ellenőrzi az első rendereléskor
    window.addEventListener('resize', handleResize);

    return () => window.removeEventListener('resize', handleResize); // Takarítás
  }, []);

  return (
    <div className="container">
      <Particles />

      <header className="header">
        <h1 className="small-heading">
          {isMobile ? (
            <button
              className="menu-toggle"
              onClick={() => setMenuOpen(!menuOpen)}
              aria-label="Toggle menu"
            >
              ☰
            </button>
          ) : (
            'bakan7'
          )}
        </h1>
        <img src="/favicon.ico" className="theme-toggle" alt="theme toggle icon" />
      </header>

      <nav className="navbar">
        <ul className={`menu ${menuOpen ? 'open' : ''}`}>
          <li>
            <a href="#" className="button" onClick={() => { setContent('home'); setMenuOpen(false); }}>Főoldal</a>
          </li>
          <li>
            <a href="#" className="button" onClick={() => { setContent('subjects'); setMenuOpen(false); }}>Tárgy info</a>
          </li>
          <li>
            <a href="#" className="button" onClick={() => { setContent('info'); setMenuOpen(false); }}>Egyetemi Linkek</a>
          </li>
          <li>
            <a href="#" className="button" onClick={() => { setContent('othersLink'); setMenuOpen(false); }}>Mások oldalai</a>
          </li>
          <li>
            <a href="#" className="button" onClick={() => { setContent('about'); setMenuOpen(false); }}>Kapcsolat</a>
          </li>
        </ul>
      </nav>

      <div className="content">
        {content === 'home' && <Home />}
        {content === 'subjects' && <SubjectInfo />}
        {content === 'info' && <UniversityLinks />}
        {content === 'othersLink' && <OthersLinks />}
        {content === 'about' && <About />}
      </div>
    </div>
  );
};

export default App;