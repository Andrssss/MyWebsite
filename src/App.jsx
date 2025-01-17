import React, { useState } from 'react';
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

  return (
    <div className="container">
      <Particles /> 

      <header className="header">
        <h1 className="small-heading">bakan7</h1>
        <img src="/favicon.ico"  className="theme-toggle" />
      </header>

      <nav className="navbar">
        <button className="menu-toggle" onClick={() => setMenuOpen(!menuOpen)}>
          ☰
        </button>
        <ul className={`menu ${menuOpen ? 'open' : ''}`}>
          <li><a href="#" className="button" onClick={() => { setContent('home'); setMenuOpen(false); }}>Főoldal</a></li>
          <li><a href="#" className="button" onClick={() => { setContent('subjects'); setMenuOpen(false); }}>Tárgy info</a></li>
          <li><a href="#" className="button" onClick={() => { setContent('info'); setMenuOpen(false); }}>Egyetemi Linkek</a></li>
          <li><a href="#" className="button" onClick={() => { setContent('othersLink'); setMenuOpen(false); }}>Mások oldalai</a></li>
          <li><a href="#" className="button" onClick={() => { setContent('about'); setMenuOpen(false); }}>Kapcsolat</a></li>
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
