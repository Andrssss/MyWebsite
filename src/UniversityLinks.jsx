import React from 'react';
import './App.css'; // Ha szükséges stílus hozzá

const universityLinks = [

  { name: 'PPKE Oktatók Elérhetőségei', url: 'https://ppke.hu/oktatok/?search=&sort_by=asc' },
  { name: 'TO oldala', url: 'https://ppke.sharepoint.com/sites/itk-to' },
  { name: 'Átlag Számoló (~nemse)', url: 'https://users.itk.ppke.hu/~nemse/atlag/' },
  { name: 'Távoktatás Felvételek', url: 'https://tavoktatas.ppke.hu/lister' },
  { name: 'PPKE Youtube', url: 'https://www.youtube.com/@ppkeitkvizmu/playlists' },
];

const UniversityLinks = () => {
  return (
    <div className="university-links">
      <ul className="university-links-list">
        {universityLinks.map((link, index) => (
          <li key={index}>
            <button
              className="university-link-button"
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

export default UniversityLinks;
