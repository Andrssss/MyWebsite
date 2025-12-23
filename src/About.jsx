import React, { useState } from 'react';
import { FaLinkedin, FaInstagram, FaEnvelope } from 'react-icons/fa';
import './page_styles/About.css';

const About = () => {
  const [showEmail, setShowEmail] = useState(false);

  return (
    <div className="about-main">
      <div className="about-container">
        <h2>Rövid Bemutatkozás</h2>

        <div className="about-text">
          <p>
            Szia, hello, nagyon eltévedhettél, ha ezt olvasod. 😄 Végzős Mérnökinformatikus hallgató
            vagyok, most el is kezdtem mellette dolgozni. Ami fantasztikus érzés,
            mert imádok dolgokat teremteni és a fejlődni. Végre azt csinálom amit gyerekként is szerettem volna.
            Nyomozó lettem. Mert az IT munka nagyrésze kitalálni 3-4 emberen keresztűl, hogy akkor mit is szeretnének. 
            Gondolatolvasás még nem megy, de egyre jobb vagyok benne. 😊
          </p>

          <p>
            Fontos számomra a munka és az élet egyensúlya. Nyilván egyetem mellett
            ez lehetetlen… tudom. <strong>DE</strong> most, hogy 4 év után végre
            szabadulok, lesz időm másra is, mint monitor vagy füzet előtt ülni.
          </p>

          <p>
            Anno elég <em>tryhard</em> voltam: a biztos 2-est csak akkor kapod meg,
            ha mindent tudsz. Ez talán a jegyzeteimen is látszik. Erre is talán büszke vagyok. 
            Sajnos a PPKE-n szerzett tudás nagy része haszontalan, szóval inkább a skillek miatt érte meg. (interjúkon szétszedtek)
          </p>

          <p>
            Hobbik terén erősnek érzem magam. Szeretek <strong>motorozni</strong>,
            szóval ha valakinek van kedve, nyugodtan keressen. 😄 Mellette kocsikázni is szeretek, főleg este, amikor kevés a sün.
            Ezen kívűl olvasni szeretek, 
            meg srácokkal elleni valamerre. Párommal random helyeket felfedezni. 
            Művészet terén a főzés az én szívem választottja.
            Szeretek a cicussunkkal összebújni, bár ez általában nem az én döntésem. xD
          </p>

          <p>
            Kb. röviden ennyi.
          </p>

          <p>Köszi, hogy elolvastad - puszi, pá. 😘</p>
        </div>

        {/* ICON SOR */}
        <div className="social-icons">
  <div className={`email-block ${showEmail ? 'open' : ''}`}>
    <button className="icon-button" onClick={() => setShowEmail(v => !v)} aria-label="Email">
      <FaEnvelope />
    </button>
    <span className="email-reveal">bak.andrs@gmail.com</span>
  </div>

  <a href="https://www.linkedin.com/in/andras-bako123/" target="_blank" rel="noopener noreferrer" aria-label="LinkedIn">
    <FaLinkedin />
  </a>

  <a href="https://www.instagram.com/and51s/" target="_blank" rel="noopener noreferrer" aria-label="Instagram">
    <FaInstagram />
  </a>
</div>

      </div>
    </div>
  );
};

export default About;
