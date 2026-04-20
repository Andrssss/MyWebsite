import React from 'react';
import './App.css'; // Ha szükséges stílus hozzá

const universityLinks = [
  
  { name: 'PPKE Oktatók Elérhetőségei ☎️', url: 'https://ppke.hu/oktatok/?search=&sort_by=asc' },
  { name: 'zimbra 📮', url: 'https://hallgato.ppke.hu/zimbra/mail#1' },
  { name: 'Neptun 📘', url: 'https://neptun3.ppke.hu/hallgato3_uj/' },
  { name: 'TO oldala 💝', url: 'https://ppke.sharepoint.com/sites/itk-to' },
  
    { name: 'PPKE chatbot 🤖', url:  ' https://mad.itk.ppke.hu/chatbot' },

  { name: 'Szakmai gyakorlat 💼', url: 'https://ppke.sharepoint.com/sites/itk-to/SitePages/Szakmai-gyakorlat.aspx' },
  { name: 'Önlab / FÖT 🧪', url: 'https://space.itk.ppke.hu/onlab/lista' },
  { name: 'Távoktatás Felvételek (Megtekint gomb) 📺', url: 'https://tavoktatas.ppke.hu/lister' },
  { name: 'PPKE Youtube ▶️', url: 'https://www.youtube.com/@ppkeitkvizmu/playlists' },
  { name: 'Átlag Számoló 🔢', url: 'https://users.itk.ppke.hu/~nemse/atlag/' },
  { name: 'TVSz kivonat 🔖', url: 'https://ppkeitk2021.notion.site/Kivonat-a-TVSz-b-l-eea98819b0b146dfad09f7596601726e' },
  { name: 'Tárgyfelvétel más mintatantervből 🙂‍💫', url: 'https://ppkeitk2021.notion.site/Kivonat-a-TVSz-b-l-eea98819b0b146dfad09f7596601726e' },
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
