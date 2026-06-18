import React, { useState, useEffect } from 'react';
import SemesterPreview from './components/SemesterPreview';
import { semesterData } from './components/semesterData_pretty';
import './Home.css';

const Home = ({ setContent, setMenuOpen }) => {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth <= 800);
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  return (
    <div className="home-container">
      <h2 style={{ color: '#fff', marginBottom: '1rem', textAlign: 'center' }}>Anyagaim :</h2>

      <div className="folder-grid">
        {Object.entries(semesterData).map(([semester, { link, subjects, videos }]) => (
          <SemesterPreview
            key={semester}
            title={semester}
            subjects={subjects}
            videos={videos}
            link={link}
          />
        ))}
      </div>
      {/*<aside className="side-col">
          <h3 className="side-title">Extra</h3>

          <a
            className="portfolio-tile"
            href="https://bakanportf.netlify.app/"
            target="_blank"
            rel="noreferrer"
            aria-label="Nyisd meg a portfóliómat új lapon"
          >
            <div className="portfolio-emoji" aria-hidden>🎓</div>
            <div className="portfolio-title">Portfólióm</div>
            <div className="portfolio-sub">külső oldal · új lapon nyílik</div>
          </a>
        </aside>*/}
    </div>
  );
};

export default Home;
