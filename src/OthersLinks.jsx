import React, { useState } from 'react';
import './App.css';


const othersLinks = [
  { name: 'pauad1 📚', url: 'https://users.itk.ppke.hu/~pauad1/' },
  { name: 'hakkeltamas 🖤', url: 'https://itk.hakkeltamas.hu/' },
  { name: 'ekacs 🦔', url: 'https://users.itk.ppke.hu/~ekacs/anyagok/' },
  { name: 'radzi1 📚', url: 'https://users.itk.ppke.hu/~radzi1/' },
  { name: 'szege7 🧩', url: 'https://users.itk.ppke.hu/~szege7/' },
  { name: 'gyoad5 🕊️', url: 'https://users.itk.ppke.hu/~gyoad5/i_sem/index.html' },
  { name: 'retge1 🍞', url: 'https://users.itk.ppke.hu/~retge1/' },
  { name: 'szama36 📘', url: 'https://users.itk.ppke.hu/~szama36/Hasznos%20dolgok/index.html' },
  { name: 'balma14 📚', url: 'https://users.itk.ppke.hu/~balma14/' },
  { name: 'bolle 📚', url: 'https://users.itk.ppke.hu/~bolle/Minden%20-by%20Bal%c3%a1zs%20M%c3%a1ty%c3%a1s/' },
  { name: 'vagle 🌀', url: 'https://users.itk.ppke.hu/~vagle/main/segedletek' },
  { name: 'hudes ☁️', url: ' https://drive.google.com/drive/folders/1Mcsi-VZUb1PcdKfhHFXn3JHNiRei28BO' },
  { name: 'petma12 📂', url: 'https://users.itk.ppke.hu/~petma12/' },
  { name: 'csobo3 📚', url: 'https://users.itk.ppke.hu/~csobo3/' },
  { name: 'juhki1 📚', url: 'https://users.itk.ppke.hu/~juhki1/jegyzetek/' },
  { name: 'nagda9 🔵', url: 'https://users.itk.ppke.hu/~nagda9/home.php' },
  { name: 'szale8 📗', url: 'https://users.itk.ppke.hu/~szale8' },
  { name: 'heihe 🌲', url: 'https://users.itk.ppke.hu/~heihe/' },
  { name: 'morak 🛰️', url: 'https://users.itk.ppke.hu/~morak/' },
  { name: 'vecha ☁️', url: 'https://mega.nz/folder/kYEiST5A#tdOn3s5WDauUS1mkhUAgDQ' },
  { name: 'PPKE WIKI 🅦', url: 'https://users.itk.ppke.hu/~marri1/?fbclid=IwZXh0bgNhZW0CMTAAAR184vSVMEMSqLJEWe3fgnc-JEl0U_gAYiXGuvkbRyy6R4VeGMj02NevaKA_aem_BG5QKzrq0RPmdpiqjOzWMw' },
];


const additionalLinks = {
  "Kevesebb anyag - 2025.07": [
    { name: 'araba4', url: 'https://users.itk.ppke.hu/~araba4/' },
    { name: 'perpa4', url: 'https://users.itk.ppke.hu/~perpa4' },
    { name: 'szumi3', url: 'https://users.itk.ppke.hu/~szumi3/' },
    { name: 'nemda3', url: 'https://users.itk.ppke.hu/~nemda3/' },
    { name: 'nemda2', url: 'https://users.itk.ppke.hu/~nemda2/' },
    { name: 'nadak', url: 'https://users.itk.ppke.hu/~nadak/#/f' },
    { name: 'fedad', url: 'https://users.itk.ppke.hu/~fedad/' },
    { name: 'kisbe32', url: 'https://users.itk.ppke.hu/~kisbe32/' },
    { name: 'misma', url: 'https://users.itk.ppke.hu/~misma/public_html_2/vsz_2020_vids.php' },
    { name: 'pocta', url: 'https://users.itk.ppke.hu/~pocta/' },
    { name: 'cseda6', url: 'https://users.itk.ppke.hu/~cseda6/public_html/files/' },
    { name: 'tarcs', url: 'https://users.itk.ppke.hu/~tarcs/' },
  ],
  "Folyamatban - 2025.07": [
    { name: 'vasbo2', url: 'https://users.itk.ppke.hu/~vasbo2' },
    { name: 'tabcs', url: 'https://users.itk.ppke.hu/~tabcs/' },
    { name: 'lazta3', url: 'https://users.itk.ppke.hu/~lazta3/' },
    { name: 'herpe3', url: 'https://users.itk.ppke.hu/~herpe3/' },
    { name: 'skulo', url: 'https://users.itk.ppke.hu/~skulo/web/index.html' },
    { name: 'kadso', url: ' https://users.itk.ppke.hu/~kadso/' },
    { name: 'orbsa2', url: ' https://users.itk.ppke.hu/~orbsa2/' },
  ],
  "GAME :": [
    { name: 'gelge1', url: 'https://users.itk.ppke.hu/~gelge1/' },
    { name: 'wagzi', url: 'https://users.itk.ppke.hu/~wagzi/G7V/' },
  ],
  "Random WTF :": [
    { name: 'juhki1', url: 'https://users.itk.ppke.hu/~juhki1/' },
    { name: 'juhga7', url: 'https://users.itk.ppke.hu/~juhga7/Jegyzetek/Honlap/galeria1.html' },
    { name: 'prabo', url: 'https://users.itk.ppke.hu/~prabo/' },
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
    { name: 'sikbo', url: 'https://users.itk.ppke.hu/~sikbo/' },
    { name: 'kovri7', url: 'https://users.itk.ppke.hu/~kovri7/' },
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