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
  const [particlesActive, setParticlesActive] = useState(true);

  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth <= 844);
    };

    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    setParticlesActive(content !== 'subjects');
  }, [content]);

  const handleNavClick = (target) => {
    setContent(target);
    setMenuOpen(false);
  };

  return (
    <div className="container">
      <Particles active={particlesActive} />

      <header className="header">
        <h1 className="small-heading">
          {isMobile ? (
            <>
              <button
                className="menu-toggle"
                onClick={() => setMenuOpen(!menuOpen)}
                aria-label="Toggle menu"
              >
                ☰
              </button>
            </>
          ) : (
            'bakan7'
          )}
        </h1>
        <img src="/favicon.ico" className="theme-toggle" alt="theme toggle icon" />
      </header>

      <nav className="navbar">
        <ul className={`menu ${menuOpen ? 'open' : ''} ${isMobile ? 'mobile' : ''}`}>
          <li>
            <a href="#" onClick={() => handleNavClick('home')}>Főoldal</a>
          </li>
          <li>
            <a href="#" onClick={() => handleNavClick('subjects')}>Tárgy info</a>
          </li>
          <li>
            <a href="#" onClick={() => handleNavClick('info')}>Egyetemi Linkek</a>
          </li>
          <li>
            <a href="#" onClick={() => handleNavClick('othersLink')}>Mások oldalai</a>
          </li>
          <li>
            <a href="#" onClick={() => handleNavClick('about')}>Kapcsolat</a>
          </li>
        </ul>
      </nav>

      <div className="content">
        {content === 'home' && <Home setContent={setContent} setMenuOpen={setMenuOpen} />}
        {content === 'subjects' && <SubjectInfo />}
        {content === 'info' && <UniversityLinks />}
        {content === 'othersLink' && <OthersLinks />}
        {content === 'about' && <About />}
      </div>
    </div>
  );
};

export default App;
