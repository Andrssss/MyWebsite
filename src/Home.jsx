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
      <h2 style={{ color: '#fff', marginBottom: '1rem', textAlign: 'center' }}>Anyagaim : </h2>

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

      <div style={{ marginTop: '2rem', textAlign: 'center' }}>
        <p style={{ color: '#aaa', marginBottom: '0.5rem', fontSize: '0.85rem' }}>Bionikás anyagok</p>
        <div style={{ display: 'flex', gap: '0.8rem', justifyContent: 'center', flexWrap: 'wrap' }}>
          <a
            href="https://users.itk.ppke.hu/~nagda9/studies.php?path=Studies"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: 'inline-block',
              padding: '0.6rem 1.4rem',
              background: 'rgba(255,255,255,0.08)',
              border: '1px solid rgba(255,255,255,0.2)',
              borderRadius: '8px',
              color: '#fff',
              textDecoration: 'none',
              fontSize: '1rem',
              letterSpacing: '0.03em',
            }}
          >
            nagda9
          </a>
          <a
            href="https://users.itk.ppke.hu/~gyoad5/"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: 'inline-block',
              padding: '0.6rem 1.4rem',
              background: 'rgba(255,255,255,0.08)',
              border: '1px solid rgba(255,255,255,0.2)',
              borderRadius: '8px',
              color: '#fff',
              textDecoration: 'none',
              fontSize: '1rem',
              letterSpacing: '0.03em',
            }}
          >
            gyoad5
          </a>
        </div>

        <p style={{ color: '#aaa', margin: '1rem 0 0.5rem', fontSize: '0.85rem' }}>További hasznos linkek</p>
        <div style={{ display: 'flex', gap: '0.8rem', justifyContent: 'center', flexWrap: 'wrap' }}>
          {[
            { name: 'PPKE WIKI 👑', url: 'https://users.itk.ppke.hu/~perpa4/' },
            { name: 'hakkeltamas 🖤', url: 'https://itk.hakkeltamas.hu/' },
            { name: 'horre20 ☁️', url: 'https://drive.google.com/drive/u/2/folders/12Dp6uZE2x61kobMxHaZ3PrUliWr3v3qj' },
            { name: 'hudes ☁️', url: 'https://drive.google.com/drive/folders/1uRxTX6odfui_A27yBAGqesNkqFM46S9m' },
            { name: 'vecha ☁️', url: 'https://mega.nz/folder/kYEiST5A#tdOn3s5WDauUS1mkhUAgDQ' },
          ].map(({ name, url }) => (
            <a
              key={url}
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'inline-block',
                padding: '0.6rem 1.4rem',
                background: 'rgba(255,255,255,0.08)',
                border: '1px solid rgba(255,255,255,0.2)',
                borderRadius: '8px',
                color: '#fff',
                textDecoration: 'none',
                fontSize: '1rem',
                letterSpacing: '0.03em',
              }}
            >
              {name}
            </a>
          ))}
        </div>
      </div>

      {/* <FileUpload /> */}
    </div>
  );
};

export default Home;
