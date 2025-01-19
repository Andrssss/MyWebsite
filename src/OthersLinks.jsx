import React from 'react';
import './App.css'; // Ha szükséges stílus hozzá

const othersLinks = [

  { name: 'pauad1', url: 'https://users.itk.ppke.hu/~pauad1/' },
  { name: 'hakkeltamas', url: 'https://itk.hakkeltamas.hu/' },
  { name: 'heihe', url: 'https://users.itk.ppke.hu/~heihe/' },
  { name: 'ekacs', url: 'https://users.itk.ppke.hu/~ekacs/anyagok' },
  { name: 'szama36', url: 'https://users.itk.ppke.hu/~szama36/Hasznos%20dolgok/index.html' },
  { name: 'misma', url: 'https://users.itk.ppke.hu/~misma/public_html_2/vsz_2020_vids.php' },
  { name: 'morak', url: 'https://users.itk.ppke.hu/~morak/' },
  { name: 'szege7', url: 'https://users.itk.ppke.hu/~szege7/' },
  { name: 'szaba30', url: 'https://users.itk.ppke.hu/~szaba30/' },
  { name: 'retge1', url: 'https://users.itk.ppke.hu/~retge1/' },
  { name: 'balma14', url: 'https://users.itk.ppke.hu/~balma14/' },
  { name: 'balma14 - lol', url: 'https://balazsmatyas429.wixsite.com/bm-s-home/file-share/cc237340-835b-4d31-bce0-a5ca48ddc9ea' },
  { name: 'bolle', url: 'https://users.itk.ppke.hu/~bolle/Minden%20-by%20Bal%c3%a1zs%20M%c3%a1ty%c3%a1s/' },
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
