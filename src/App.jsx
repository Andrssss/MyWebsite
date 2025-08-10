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
import LinksLauncher from './LinksLauncher.jsx';


const AppContent = () => {
  const [menuOpen, setMenuOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [particlesActive, setParticlesActive] = useState(true);
  const location = useLocation();
  const [initialPath, setInitialPath] = useState(null);
  const [hasNavigatedAway, setHasNavigatedAway] = useState(false);
  const [subjectInfoLoading, setSubjectInfoLoading] = useState(false);



  useEffect(() => {
    setParticlesActive(location.pathname !== '/targy_info');
  }, [location]);

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth <= 500);
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);



useEffect(() => {
  if (initialPath === null) {
    setInitialPath(location.pathname);
  } else if (location.pathname !== initialPath && !hasNavigatedAway) {
    setHasNavigatedAway(true);
  }
}, [location, initialPath, hasNavigatedAway]);


  

  return (
    <div className={`${isMobile ? 'container' : 'layout'} ${
      !isMobile && hasNavigatedAway && !(location.pathname === '/targy_info' && subjectInfoLoading)
        ? 'sb-collapsed'
        : ''
     }`}>
      <div className="particles-wrapper">
        <div className="background-image"></div> {/* Háttérkép */}
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
              <li><Link to="/gyakornoki_poziciok" onClick={() => setMenuOpen(false)}>Gyakornoki linkek</Link></li>
              <li><Link to="/kapcsolat" onClick={() => setMenuOpen(false)}>Kapcsolat</Link></li>
            </ul>

          </nav>
        </>
      ) :  (
        //!isMobile => desktop nézet - itt jön az új aside blokk
        !isMobile && (
          <aside className={`sidebar ${hasNavigatedAway && !(location.pathname === '/targy_info' && subjectInfoLoading) ? 'collapsed' : ''}`}>
            <div className="logo">bakan7</div>
            <nav>
              <ul>
                <li><Link to="/">📂 Főoldal</Link></li>
                <li><Link to="/targy_info">📘 Tárgy infok</Link></li>
                <li><Link to="/egyetemi_linkek">🔗 Egyetemi linkek</Link></li>
                <li><Link to="/masok_oldalai">🌐 Mások oldalai</Link></li>
                <li><Link to="/gyakornoki_poziciok">💼 Gyakornoki pozi</Link></li>
                <li><Link to="/kapcsolat">📬 Kapcsolat</Link></li>
                
              </ul>
            </nav>
          </aside>
        )
      )}

      <main className={`${isMobile ? 'content' : 'main-content'} ${!isMobile && hasNavigatedAway  && !(location.pathname === '/targy_info' && subjectInfoLoading) ? 'collapsed' : ''}`}>
        <Routes>
          <Route path="/" element={<Home setContent={() => {}} setMenuOpen={setMenuOpen} />} />
          <Route path="/targy_info" element={<SubjectInfo setLoading={setSubjectInfoLoading} />} />
          <Route path="/egyetemi_linkek" element={<UniversityLinks />} />
          <Route path="/masok_oldalai" element={<OthersLinks />} />
          <Route path="/kapcsolat" element={<About />} />
          <Route
            path="/gyakornoki_poziciok"
            element={<div className="main-content re-page"><LinksLauncher /></div>}
          />
          <Route
            path="/gyakornoki_poziciok/auto"
            element={<div className="main-content re-page"><LinksLauncher autoOpen /></div>}
          />
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
