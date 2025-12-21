import React from 'react';
import { FaLinkedin, FaInstagram } from 'react-icons/fa';
import './About.css';

const About = () => {
  return (
    <div className="about-main">
      <div className="about-container">
        <h2>Kapcsolat</h2>

        <p>
          Ha szeretnél elérni, írj emailt:{' '}
          <a href="mailto:bak.andrs@gmail.com">bak.andrs@gmail.com</a>
        </p>

        <p>
          Az oldal fejlesztés alatt van. Anyagok kerülni fognak fel,
          mivel majd csak 2026-ban végzek.
        </p>

        <p>
          Ami a legszekszibb az oldalamban, hogy az anyagok között vannak
          videók is. De hogy így tényleg sok. Olyanok is, amiket máshol
          nem találsz meg.
        </p>

        {/* 🔽 SOCIAL ICONS */}
        <div className="social-icons">
          <a
            href="https://www.linkedin.com/in/SAJAT-LINKEDIN"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="LinkedIn"
          >
            <FaLinkedin />
          </a>

          <a
            href="https://www.instagram.com/SAJAT-INSTA"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Instagram"
          >
            <FaInstagram />
          </a>
        </div>
      </div>
    </div>
  );
};

export default About;
  