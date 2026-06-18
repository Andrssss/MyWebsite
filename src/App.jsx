import React, { useState, useEffect, useRef } from 'react';
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
import About from './About.jsx';
import SubjectInfo from './SubjectInfo.jsx';
import User_pages from './User_pages.tsx';
import JobWatcher from "./JobWatcher.jsx";
import Filters from "./Filters.jsx";
import Categories from "./Categories.jsx";
import JobStats from "./JobStats.jsx";

const AppContent = () => {
  const [menuOpen, setMenuOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const location = useLocation();
  const [initialPath, setInitialPath] = useState(null);
  const [hasNavigatedAway, setHasNavigatedAway] = useState(false);
  const [subjectInfoLoading, setSubjectInfoLoading] = useState(false);
  const [manuallyCollapsed, setManuallyCollapsed] = useState(false);
  const [noHover, setNoHover] = useState(false);
  const sidebarRef = useRef(null);

  const isHome = location.pathname === '/';
  const sidebarCollapsed = (hasNavigatedAway || manuallyCollapsed) && !(location.pathname === '/targy_info' && subjectInfoLoading);

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth <= 800);
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
    <div className={`${isMobile ? 'container' : 'layout'} ${!isMobile && sidebarCollapsed ? 'sb-collapsed' : ''} ${isHome ? 'on-home' : ''}`}>
      <div className="particles-wrapper">
        <video
          className={`background-video${location.pathname === '/targy_info' ? ' bg-hidden' : ''}`}
          autoPlay
          loop
          muted
          playsInline
        >
          <source src="/IMG_0006_bg.mp4" type="video/mp4" />
        </video>
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
              <li><Link to="/User_oldalak" onClick={() => setMenuOpen(false)}>User oldalak</Link></li>
              <li><Link to="/allasfigyelo" onClick={() => setMenuOpen(false)}>Állásfigyelő</Link></li>
              <li><Link to="/rolam" onClick={() => setMenuOpen(false)}>Rólam</Link></li>
            </ul>

          </nav>
        </>
      ) :  (
        //!isMobile => desktop nézet - itt jön az új aside blokk
        !isMobile && (
          <aside
            ref={sidebarRef}
            className={`sidebar ${sidebarCollapsed ? 'collapsed' : ''} ${noHover ? 'no-hover' : ''}`}
            onMouseLeave={() => { if (noHover) setNoHover(false); }}
          >
            <div className="logo">
              bakan7
              {!sidebarCollapsed && (
                <button
                  className="sidebar-close-btn"
                  onClick={() => {
                    setManuallyCollapsed(true);
                    setNoHover(true);
                  }}
                >‹</button>
              )}
            </div>
            <nav>
              <ul>
                <li><Link to="/">📂 Főoldal</Link></li>
                <li><Link to="/targy_info">📘 Tárgy infok</Link></li>
                <li><Link to="/egyetemi_linkek">🔗 Egyetemi linkek</Link></li>
                <li><Link to="/User_oldalak">🧭 User oldalak</Link></li>
                <li><Link to="/allasfigyelo">✨ Állásfigyelő</Link></li>
                <li><Link to="/rolam">👤 Rólam</Link></li>
                
              </ul>
            </nav>
          </aside>
        )
      )}

      <main className={`${isMobile ? 'content' : 'main-content'} ${!isMobile && sidebarCollapsed ? 'collapsed' : ''} ${isHome ? 'pad-right' : ''}`}>
        <Routes>
          <Route path="/" element={<Home setContent={() => {}} setMenuOpen={setMenuOpen} />} />
          <Route path="/targy_info" element={<SubjectInfo setLoading={setSubjectInfoLoading} />} />
          <Route path="/egyetemi_linkek" element={<UniversityLinks />} />
          <Route path="/User_oldalak" element={<User_pages />} />
          <Route path="/rolam" element={<About />} />

          {/* Állásfigyelő */}
          <Route
            path="/allasfigyelo"
            element={
              <div className="re-page">
                <JobWatcher />
              </div>
            }
          />

          {/* Filters – rejtett, nincs rá gomb */}
          <Route
            path="/allasfigyelo/filters"
            element={
              <div className="re-page">
                <Filters />
              </div>
            }
          />

          {/* Categories – rejtett, nincs rá gomb */}
          <Route
            path="/allasfigyelo/categories"
            element={
              <div className="re-page">
                <Categories />
              </div>
            }
          />

          {/* Statisztikák */}
          <Route
            path="/allasfigyelo/stats"
            element={
              <div className="re-page">
                <JobStats />
              </div>
            }
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
