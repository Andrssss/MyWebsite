import React, { useState, useEffect } from 'react';
import {
  BrowserRouter as Router,
  Routes,
  Route,
  Navigate,
  Link,
  useLocation,
} from 'react-router-dom';

import './App.css';
import Home from './Home';
import UniversityLinks from './UniversityLinks.jsx';
import OthersLinks from './OthersLinks.jsx';
import About from './About.jsx';
import SubjectInfo from './SubjectInfo.jsx';
import Particles from './Particles.jsx';

const AppContent = () => {
  const [menuOpen, setMenuOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [particlesActive, setParticlesActive] = useState(true);
  const location = useLocation();

  useEffect(() => {
    setParticlesActive(location.pathname !== '/targy_info');
  }, [location]);

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth <= 844);
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  useEffect(() => {
    // Ha nem a főoldalon vagyunk, zárjuk össze a sidebart
    setSidebarCollapsed(location.pathname !== '/');
  }, [location]);
  

  return (
    <div className={isMobile ? 'container' : 'layout'}>
      <div className="particles-wrapper">
        <Particles active={particlesActive} />
      </div>


      {isMobile ? (
        <>
          <header className="header">
            <h1 className="small-heading">
              <button
                className="menu-toggle"
                onClick={() => setMenuOpen(!menuOpen)}
                aria-label="Toggle menu"
              >
                ☰
              </button>
            </h1>
            <img
              src="/favicon.ico"
              className="theme-toggle"
              alt="theme toggle icon"
            />
          </header>

          <nav className="navbar">
            <ul className={`menu ${menuOpen ? 'open' : ''} mobile`}>
              <li><Link to="/" onClick={() => setMenuOpen(false)}>Főoldal</Link></li>
              <li><Link to="/targy_info" onClick={() => setMenuOpen(false)}>Tárgy info</Link></li>
              <li><Link to="/egyetemi_linkek" onClick={() => setMenuOpen(false)}>Egyetemi Linkek</Link></li>
              <li><Link to="/masok_oldalai" onClick={() => setMenuOpen(false)}>Mások oldalai</Link></li>
              <li><Link to="/kapcsolat" onClick={() => setMenuOpen(false)}>Kapcsolat</Link></li>
            </ul>
          </nav>
        </>
      ) : (
        <aside className={`sidebar ${!isMobile && location.pathname !== '/' ? 'collapsed' : ''}`}>
          <div className="logo">bakan7</div>
          <nav>
            <ul>
              <li><Link to="/">📂 Főoldal</Link></li>
              <li><Link to="/targy_info">📘 Tárgy info</Link></li>
              <li><Link to="/egyetemi_linkek">🔗 Egyetemi linkek</Link></li>
              <li><Link to="/masok_oldalai">🌐 Más oldalak</Link></li>
              <li><Link to="/kapcsolat">📬 Kapcsolat</Link></li>
            </ul>
          </nav>
        </aside>

      )}

      <main className={`${isMobile ? 'content' : 'main-content'} ${!isMobile && location.pathname !== '/' ? 'collapsed' : ''}`}>
        <Routes>
          <Route path="/" element={<Home setContent={() => {}} setMenuOpen={setMenuOpen} />} />
          <Route path="/targy_info" element={<SubjectInfo />} />
          <Route path="/egyetemi_linkek" element={<UniversityLinks />} />
          <Route path="/masok_oldalai" element={<OthersLinks />} />
          <Route path="/kapcsolat" element={<About />} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </main>
    </div>
  );
};

const App = () => (
  <Router>
    <AppContent />
  </Router>
);

export default App;
