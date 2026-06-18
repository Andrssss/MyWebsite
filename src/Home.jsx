import React, { useState, useEffect } from 'react';
import SemesterPreview from './components/SemesterPreview';
import FileUpload from './components/FileUpload';
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
      <h2 style={{ color: '#fff', marginBottom: '1rem', textAlign: 'center' }}>Még video linkek fognak felkerűlni !!!</h2>

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
      {/* <FileUpload /> */}
    </div>
  );
};

export default Home;
