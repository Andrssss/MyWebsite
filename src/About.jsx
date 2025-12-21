import React from 'react';
import { FaLinkedin, FaInstagram, FaEnvelope } from 'react-icons/fa';
import './page_styles/About.css';

const About = () => {
  return (
    <div className="about-main">
      <div className="about-container">
        <h2>Rövid Bemutatkozás</h2>

        <div className="about-text">
        <p>
          Szia, helo, nagyon eltévedhettél, ha ezt olvasod. 😄  
          Végzős MI hallgató vagyok, most el is kezdtem mellette dolgozni.
          Ami fantasztikus érzés, mert imádok dolgokat teremteni és a fejtörőket is.
        </p>

        <p>
          Fontos számomra a munka és az élet egyensúlya.
          Nyilván egyetem mellett ez lehetetlen… tudom.  
          <strong>DE</strong> most, hogy 4 év után végre szabadulok,
          lesz időm másra is, mint monitor vagy füzet előtt ülni.
        </p>

        <p>
          Anno elég <em>tryhard</em> voltam: a biztos 2-est csak akkor kapod meg,
          ha mindent tudsz. Ez talán a jegyzeteimen is látszik.
        </p>

        <p>
          Hobbik terén erősnek érzem magam. Szeretek <strong>motorozni</strong>,
          szóval ha valakinek van kedve, nyugodtan keressen. Arra mindig vevő vagyok. 😄  
          Emellett szoktam olvasni.
    
          Imádok bütykölni és időnként jól tönkretenni dolgokat, amikor épp próbálom megjavítani a dolgokat.
          De hát hibákból tanul a legtöbbet az ember.
    
          Szeretek a cicussal összebújni,
          bár ez általában nem az én döntésem. xD  
          (Mert ha te emeled fel, az neki nem jó.)
        </p>

        <p>
          Jó látni, hogy sokaknak segít az oldalam,
          mert az életben az egyik legszebb dolog
          az önzetlen adakozás.
          <br />
          De azért egy sörre meghívhatsz. xD
        </p>

        <p>
          Köszi, hogy elolvastad - puszi, pá. 😘
        </p>
      </div>
        <div className="social-icons">
          <a
            href="mailto:bak.andrs@gmail.com"
            aria-label="Email"
            title="Email"
          >
            <FaEnvelope />
          </a>

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
