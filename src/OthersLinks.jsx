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
  { name: 'balma14', url: 'https://users.itk.ppke.hu/~balma14/' },
  { name: 'szege7', url: 'https://users.itk.ppke.hu/~szege7/' },
  { name: 'szaba30', url: 'https://users.itk.ppke.hu/~szaba30/' },
  { name: 'retge1', url: 'https://users.itk.ppke.hu/~retge1/' },
  { name: 'balma14', url: 'https://balazsmatyas429.wixsite.com/bm-s-home/file-share/cc237340-835b-4d31-bce0-a5ca48ddc9ea' },
  { name: 'bolle', url: 'https://users.itk.ppke.hu/~bolle/Minden%20-by%20Bal%c3%a1zs%20M%c3%a1ty%c3%a1s/' },

];
const OthersLinks = () => {
  return (
    <div className="others-links"> 
      <ul className="others-links-list">
        {othersLinks.map((link, index) => (
          <li key={index}>
            <button
              className="others-link-button"
              onClick={() => window.open(link.url, '_blank')}
            >
              {link.name}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
};

export default OthersLinks;
