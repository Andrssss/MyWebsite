import React, { useState } from 'react';
import './About.css';

const About = () => {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [status, setStatus] = useState('');

  const handleSubmit = (e) => {
    e.preventDefault();
    // Egyszerű üzenetküldési logika
    setStatus('Az üzenet sikeresen elküldve!');
    setName('');
    setEmail('');
    setMessage('');
  };

  return (
    <div className="about-container">
      <h2>Kapcsolat</h2>
      <p>Ha szeretnél elérni, vagy felkerülni a listára, akkor írj emailt: <a href="mailto:bak.andrs@gmail.com">bak.andrs@gmail.com</a></p>
      {/* <label htmlFor="name">Név:</label>
  <input
    type="text"
    id="name"
    value={name}
    onChange={(e) => setName(e.target.value)}
    required
  />

  <label htmlFor="email">Email:</label>
  <input
    type="email"
    id="email"
    value={email}
    onChange={(e) => setEmail(e.target.value)}
    required
  />

  <label htmlFor="message">Üzenet:</label>
  <textarea
    id="message"
    value={message}
    onChange={(e) => setMessage(e.target.value)}
    required
  ></textarea>

  <button type="submit">Küldés</button> */}
      {status && <p className="status-message">{status}</p>}
    </div>
  );
};

export default About;
