import React, { useState } from 'react';
import { FaLinkedin, FaInstagram, FaEnvelope } from 'react-icons/fa';
import './page_styles/About.css';

const About = () => {
  const [showEmail, setShowEmail] = useState(false);

  return (
    <div className="about-main">
      <div className="about-container">
        
        <div className="header-row">
            <h2 className="about-title">Rövid Bemutatkozás</h2>
                <div className="profile-image">
            <img src="/IMG_0292.jpg" alt="András Bakó" />
          </div>
        </div>


        <div className="about-text">
          <p>
            Szia. Örülök, hogy ezt olvasod. :) 
          </p>
          <p>
            Végzős Mérnökinformatikus hallgató vagyok, most el is kezdtem mellette dolgozni, mint <strong>teszt autómatizáció</strong>-s gyakornok.

             Ami elég fun munka. Jó kis kreatív. Meg végre azt csinálom amit gyerekként is szerettem volna, mert lényegében 
             nyomozó lettem. Mivel az IT munka nagyrésze kitalálni 3-4 emberen keresztűl, hogy akkor mit is szeretnének pontosan.
              Szóval social skillek sok esetben fontosabbak, mint az IT-sok. ( Ezt azért mondom, mert sok IT-s kollégám van, akiknek minősíthetetlenül szar 
              kódjai vannak, de viccesek, szóval 2 éve itt dolgoznak. Ha belegondolsz amúgy logikus. )
          </p>

          <p>
            Fontos számomra a munka és az élet egyensúlya. Nyilván egyetem mellett ez lehetetlen volt …
          </p>

          <p>
            Anno elég <em>tryhard </em> voltam, mivel nekem a célom az volt, hogy megtanuljak mindent és ezzel kerüljek mások elé. 
            Erre rásegít a munkamániásságom, a kitartásom és a makacsságom. Utolsó kettő tulajdonságomat a két év profibb szintű <strong>Crossfit</strong>-nek köszönhetem. 
            Az egy izgalmas sport, ha komolyan veszed. Sok stratégia van, amivel a tested kitartóképességét lehet növelni.  (Pl.: étkezés, düh kezelés, gondolat manipulálás)
            Ezek a skillek talán a jegyzeteimen is látszanak. Erre is büszke vagyok. Meg jó érzés, hogy ez segíteni fog a pisiseknek. 😄 
            Sajnos a PPKE-n szerzett tudás nagy része haszontalan, szóval inkább a skillek miatt érte meg. (interjúkon szétszedtek)
          </p>

          <p>
            Hobbik terén erősnek érzem magam. Szeretek <strong>motorozni</strong>, szóval ha valakinek van kedve, nyugodtan keressen. 😄 
            Mellette kocsikázni is szeretek. Szeretek random dolgokat megjavítani. Ezen kívűl ilyen klisés dolgokat is szeretek, mint hogy olvasni, 
            meg srácokkal elleni valamerre, párommal random helyeket felfedezni. Ilyesmik. Művészet terén a főzés az én szívem választottja.
          </p>

          <p>
            Kb. röviden ennyi. Kitartást mindekinek. Élvezzétek ki az egyetemet, mert "ezek a legszebb éveid". ( Érdekes, hogy ezt nem mérnököktől szoktam hallani.. xD )
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
