import React, { useState, useEffect } from 'react';
import SemesterPreview from './components/SemesterPreview';
import { semesterData } from './components/semesterData_pretty';

const Home = ({ setContent, setMenuOpen }) => {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth <= 768);
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  return (
    <div className="home-container">
      <h2 style={{ color: '#fff', marginBottom: '1rem' }}>Jegyzeteim:</h2>
      <div className="folder-grid">
        {Object.entries(semesterData).map(([semester, { link, subjects }]) => (
          <SemesterPreview
            key={semester}
            title={semester}
            subjects={subjects}
            link={link}
          />
        ))}
      </div>
    </div>
  );
};

export default Home;
