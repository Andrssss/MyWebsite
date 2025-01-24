import React, { useState } from 'react';
import './App.css';

const othersLinks = [

  { name: 'pauad1', url: 'https://users.itk.ppke.hu/~pauad1/' },
  { name: 'hakkeltamas', url: 'https://itk.hakkeltamas.hu/' },
  { name: 'heihe', url: 'https://users.itk.ppke.hu/~heihe/' },
  { name: 'ekacs', url: 'https://users.itk.ppke.hu/~ekacs' },
  { name: 'szege7', url: 'https://users.itk.ppke.hu/~szege7/' },
  { name: 'retge1', url: 'https://users.itk.ppke.hu/~retge1/' },
  { name: 'szama36', url: 'https://users.itk.ppke.hu/~szama36/Hasznos%20dolgok/index.html' },
  { name: 'morak', url: 'https://users.itk.ppke.hu/~morak/' },
  { name: 'balma14', url: 'https://users.itk.ppke.hu/~balma14/' },
  { name: 'bolle', url: 'https://users.itk.ppke.hu/~bolle/Minden%20-by%20Bal%c3%a1zs%20M%c3%a1ty%c3%a1s/' },
  { name: 'vagle', url: 'https://users.itk.ppke.hu/~vagle/main/' },
  { name: 'hudes', url: ' https://drive.google.com/drive/folders/1Mcsi-VZUb1PcdKfhHFXn3JHNiRei28BO' },
  { name: 'petma12', url: 'https://markomy.hu/' },
  { name: 'csobo3', url: 'https://users.itk.ppke.hu/~csobo3/' },
  
  
  { name: 'radzi1', url: 'https://users.itk.ppke.hu/~radzi1/' },
  { name: 'PPKE WIKI', url: 'https://users.itk.ppke.hu/~marri1/?fbclid=IwZXh0bgNhZW0CMTAAAR184vSVMEMSqLJEWe3fgnc-JEl0U_gAYiXGuvkbRyy6R4VeGMj02NevaKA_aem_BG5QKzrq0RPmdpiqjOzWMw' },
];


const additionalLinks = {
  "Kevesebb anyag - 2025.01": [
    { name: 'szumi3', url: 'https://users.itk.ppke.hu/~szumi3/' },
    { name: 'nemda3', url: 'https://users.itk.ppke.hu/~nemda3/' },
    { name: 'nemda2', url: 'https://users.itk.ppke.hu/~nemda2/' },
    { name: 'nadak', url: 'https://users.itk.ppke.hu/~nadak/#/f' },
    { name: 'fedad', url: 'https://users.itk.ppke.hu/~fedad/' },
    { name: 'kisbe32', url: 'https://users.itk.ppke.hu/~kisbe32/' },
    { name: 'misma', url: 'https://users.itk.ppke.hu/~misma/public_html_2/vsz_2020_vids.php' },
    { name: 'pocta', url: 'https://users.itk.ppke.hu/~pocta/' },

  ],
  "Folyamatban - 2025.01": [
    { name: 'vasbo2', url: 'https://users.itk.ppke.hu/~vasbo2' },
    { name: 'tabcs', url: 'https://users.itk.ppke.hu/~tabcs/' },
    { name: 'lazta3', url: 'https://users.itk.ppke.hu/~lazta3/' },
    { name: 'herpe3', url: 'https://users.itk.ppke.hu/~herpe3/' },
    { name: 'skulo', url: 'https://users.itk.ppke.hu/~skulo/web/index.html' },

    
  ],
  "GAME :": [
    { name: 'gelge1', url: 'https://users.itk.ppke.hu/~gelge1/' },
    { name: 'wagzi', url: 'https://users.itk.ppke.hu/~wagzi/G7V/' },
  ],
  "Random WTF :": [
    { name: 'kovzo14', url: 'https://users.itk.ppke.hu/~kovzo14' },
    { name: 'juhbe8', url: 'https://users.itk.ppke.hu/~juhbe8/' },
    { name: 'szeem4', url: 'https://users.itk.ppke.hu/~szeem4' },
    { name: 'berbo5', url: 'https://users.itk.ppke.hu/~berbo5' },
    { name: 'kolcs', url: 'https://users.itk.ppke.hu/~kolcs' },
    { name: 'totbe31', url: 'https://users.itk.ppke.hu/~totbe31' },
    { name: 'tolma1', url: 'https://users.itk.ppke.hu/~tolma1/' },
    { name: 'fabal3', url: 'https://users.itk.ppke.hu/~fabal3/' },
    { name: 'hugal', url: 'https://users.itk.ppke.hu/~hugal/' },
    { name: 'mulkr', url: 'https://users.itk.ppke.hu/~mulkr/' },
    
  ],
};


const OthersLinks = () => {
  const [isPopupVisible, setPopupVisible] = useState(false);

  const togglePopup = () => {
    setPopupVisible(!isPopupVisible);
  };

  return (
    <div className="others-links">
      <ul className="others-links-list">
        {othersLinks.map((link, index) => (
          <li key={index}>
            <a
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              className="others-link-button-wrapper"
            >
              <button className="others-link-button">{link.name}</button>
            </a>
          </li>
        ))}
        <li>
          <button className="others-link-button" onClick={togglePopup}>
            További linkek
          </button>
        </li>
      </ul>

      {isPopupVisible && (
        <div className="popup-overlay" onClick={togglePopup}>
          <div className="popup-content" onClick={(e) => e.stopPropagation()}>
            <button className="close-button" onClick={togglePopup}>
              &times;
            </button>
            <h3>További linkek</h3>
            {Object.keys(additionalLinks).map((category, index) => (
              <div key={index}>
                <h4>{category}</h4>
                <ul>
                  {additionalLinks[category].map((link, linkIndex) => (
                    <li key={linkIndex}>
                      <a href={link.url} target="_blank" rel="noopener noreferrer">
                        {link.name}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default OthersLinks;
