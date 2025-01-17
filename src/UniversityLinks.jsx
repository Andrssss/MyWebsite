import React from 'react';
import './App.css'; // Ha szükséges stílus hozzá

const universityLinks = [
  
  { name: 'PPKE Oktatók Elérhetőségei', url: 'https://ppke.hu/oktatok/?search=&sort_by=asc' },
  { name: 'PPKE WIKI', url: 'https://users.itk.ppke.hu/~marri1/?fbclid=IwZXh0bgNhZW0CMTAAAR184vSVMEMSqLJEWe3fgnc-JEl0U_gAYiXGuvkbRyy6R4VeGMj02NevaKA_aem_BG5QKzrq0RPmdpiqjOzWMw' },
  { name: 'TO oldala', url: 'https://ppke.sharepoint.com/sites/itk-to' },
  { name: 'zimbra', url: 'https://hallgato.ppke.hu/zimbra/mail#1' },
  { name: 'Átlag Számoló', url: 'https://users.itk.ppke.hu/~nemse/atlag/' },
  { name: 'Távoktatás Felvételek (Megtekint gomb)', url: 'https://tavoktatas.ppke.hu/lister' },
  { name: 'PPKE Youtube', url: 'https://www.youtube.com/@ppkeitkvizmu/playlists' },
  { name: 'Router GS', url: 'https://docs.google.com/spreadsheets/d/1xEBut8sYk9PWuCxnBX9B6EWZTTdkwSURAuMokW0SF_0/edit?gid=0#gid=0' },
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
