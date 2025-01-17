import React, { useState } from 'react';
import './About.css';

const About = () => {
  return (
    <div className="about-container">
      <h2>Kapcsolat</h2>
      <p>Ha szeretnél elérni, vagy felkerülni a listára vagy anygot megosztani, akkor írj emailt: <a href="mailto:bak.andrs@gmail.com">bak.andrs@gmail.com</a></p>
      {status && <p className="status-message">{status}</p>}
    </div>
  );
};

export default About;
