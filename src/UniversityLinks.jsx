import React from 'react';
import './App.css'; // Ha szükséges stílus hozzá

const universityLinks = [
  
  { name: 'PPKE Oktatók Elérhetőségei ☎️', url: 'https://ppke.hu/oktatok/?search=&sort_by=asc' },
  { name: 'TVSz kivonat 🔖', url: 'https://ppkeitk2021.notion.site/Kivonat-a-TVSz-b-l-eea98819b0b146dfad09f7596601726e' },
  { name: 'TO oldala 💝', url: 'https://ppke.sharepoint.com/sites/itk-to' },
  { name: 'Szakmai gyakorlat 💼', url: 'https://ppke.sharepoint.com/sites/itk-to/SitePages/Szakmai-gyakorlat.aspx' },
  { name: 'zimbra 📮', url: 'https://hallgato.ppke.hu/zimbra/mail#1' },
  { name: 'Átlag Számoló 🔢', url: 'https://users.itk.ppke.hu/~nemse/atlag/' },
  { name: 'Távoktatás Felvételek (Megtekint gomb) 📺', url: 'https://tavoktatas.ppke.hu/lister' },
  { name: 'PPKE Youtube ▶️', url: 'https://www.youtube.com/@ppkeitkvizmu/playlists' },
  { name: 'ITK-s tárgytapasztalatok 💬', url: 'https://docs.google.com/spreadsheets/d/1Bi4nMQZ5S6c8bXx3Xl73snqcYVgtKye8mOMc2MsA1fY/edit?gid=0#gid=0' },
];



const UniversityLinks = () => {
  return (
    <div className="university-links">
      <ul className="university-links-list">
        {universityLinks.map((link, index) => (
          <li key={index}>
            <a
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              className="university-link-button-wrapper"
            >
              <button className="university-link-button">
                {link.name}
              </button>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default UniversityLinks;
