import React from 'react';
import './App.css'; // Ha szükséges stílus hozzá

const othersLinks = [

  { name: 'pauad1', url: 'https://users.itk.ppke.hu/~pauad1/' },
  { name: 'hakkeltamas', url: 'https://itk.hakkeltamas.hu/' },
  { name: 'heihe', url: 'https://users.itk.ppke.hu/~heihe/' },
  { name: 'ekacs', url: 'https://users.itk.ppke.hu/~ekacs' },
  { name: 'szama36', url: 'https://users.itk.ppke.hu/~szama36/Hasznos%20dolgok/index.html' },
  { name: 'misma', url: 'https://users.itk.ppke.hu/~misma/public_html_2/vsz_2020_vids.php' },
  { name: 'morak', url: 'https://users.itk.ppke.hu/~morak/' },
  { name: 'szege7', url: 'https://users.itk.ppke.hu/~szege7/' },
  { name: 'szaba30', url: 'https://users.itk.ppke.hu/~szaba30/' },
  { name: 'retge1', url: 'https://users.itk.ppke.hu/~retge1/' },
  { name: 'balma14', url: 'https://users.itk.ppke.hu/~balma14/' },
  { name: 'bolle', url: 'https://users.itk.ppke.hu/~bolle/Minden%20-by%20Bal%c3%a1zs%20M%c3%a1ty%c3%a1s/' },
  
  
  
  { name: 'vagle', url: 'https://users.itk.ppke.hu/~vagle/main/' },
  { name: 'nadak', url: 'https://users.itk.ppke.hu/~nadak/#/' },
  { name: 'hudes', url: ' https://drive.google.com/drive/folders/1Mcsi-VZUb1PcdKfhHFXn3JHNiRei28BO' },
  { name: 'tarcs', url: '  https://users.itk.ppke.hu/~tarcs/' },
  { name: 'tabcs', url: '  https://users.itk.ppke.hu/~tabcs/' },
  { name: 'petma12', url: 'https://markomy.hu/' },
  { name: 'csobo3', url: 'https://users.itk.ppke.hu/~csobo3/' },
  { name: 'szumi3', url: 'https://users.itk.ppke.hu/~szumi3/' },
  { name: 'nemda2', url: 'https://users.itk.ppke.hu/~nemda2/' },
  { name: 'nemda3', url: 'https://users.itk.ppke.hu/~nemda3/' },
  { name: 'papbe5', url: 'https://users.itk.ppke.hu/~papbe5/' },
  { name: 'gedge1 - GAME', url: 'https://users.itk.ppke.hu/~gelge1/' },
  { name: 'wagzi - GAME', url: 'https://users.itk.ppke.hu/~wagzi/G7V/' },
  

  
  { name: 'PPKE WIKI', url: 'https://users.itk.ppke.hu/~marri1/?fbclid=IwZXh0bgNhZW0CMTAAAR184vSVMEMSqLJEWe3fgnc-JEl0U_gAYiXGuvkbRyy6R4VeGMj02NevaKA_aem_BG5QKzrq0RPmdpiqjOzWMw' },

];
const OthersLinks = () => {
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
              <button className="others-link-button">
                {link.name}
              </button>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
};


export default OthersLinks;
