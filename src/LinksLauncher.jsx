import React, { useEffect, useState, useCallback } from 'react';

const JOB_PORTALS = [
  { label: 'Melódiák – gyakornoki', url: 'https://www.melodiak.hu/diakmunkak/?l=gyakornoki-szakmai-munkak&ca=informatikai-mernoki-muszaki' },
  { label: 'Minddiák ', url: 'https://minddiak.hu/position?page=2' },
  { label: 'Muisz – gyakornoki kategória', url: 'https://muisz.hu/hu/diakmunkaink?categories=3' },
  { label: 'CV Centrum – gyakornok IT', url: 'https://cvcentrum.hu/allasok/?s=gyakornok&category%5B%5D=it&category%5B%5D=it-programozas&category%5B%5D=it-uzemeltetes' },
  { label: 'CV Centrum – intern IT', url: 'https://cvcentrum.hu/?s=intern&category%5B%5D=information-technology&category%5B%5D=it&category%5B%5D=it-programozas&category%5B%5D=it-uzemeltetes&category%5B%5D=networking&type=&_noo_job_field_year_experience=&post_type=noo_job' },
  { label: 'Zyntern – IT/fejlesztés', url: 'https://zyntern.com/jobs?fields=16' },
  { label: 'Profession – IT fejlesztés (intern)', url: 'https://www.profession.hu/allasok/it-programozas-fejlesztes/1,10,0,intern' },
  { label: 'Profession – (gyakornok)', url: 'https://www.profession.hu/allasok/it-uzemeltetes-telekommunikacio/1,25,0,gyakornok' },
  { label: 'Fürge Diák – gyakornok', url: 'https://gyakornok.furgediak.hu/allasok?statikusmunkakor=7' },
  { label: 'Schönherz – Budapest fejlesztő/tesztelő', url: 'https://schonherz.hu/diakmunkak/budapest/fejleszto---tesztelo' },
  { label: 'Frissdiplomás – állások', url: 'https://www.frissdiplomas.hu/allasok' },
  { label: 'Prodiák – IT állások', url: 'https://www.prodiak.hu/adverts/it-5980e4975de0fe1b308b460a/osszes/kulfold' }
];

const COMPANIES = [
  { label: 'OTP Karrier – GYAKORNOK', url: 'https://karrier.otpbank.hu/go/Minden-allasajanlat/1167001/?q=&q2=&alertId=&locationsearch=&title=GYAKORNOK&date=&location=&shifttype=' },
  { label: 'TCS Hungary – állások', url: 'https://hungarycareer.tcsapps.com/?s=' },
  { label: 'AVL – állások', url: 'https://jobs.avl.com/search/?createNewAlert=false&q=&locationsearch=hu' },
  { label: 'MOL – állások', url: 'https://molgroup.taleo.net/careersection/external/jobsearch.ftl?lang=hu' },
  { label: 'Taboola – állások', url: 'https://www.taboola.com/careers/jobs#team=&location=31734' },
  { label: 'Siemens – állások', url: 'https://jobs.siemens.com/careers/search?query=%2A&location=Budapest%2C%20Hungary&pid=563156121706158&level=student%20%28not%20yet%20graduated%29&level=early%20professional&level=recent%20college%20graduate&level=not%20defined&domain=siemens.com&sort_by=relevance&location_distance_km=25&triggerGoButton=false' },
  { label: 'Mediso – állások', url: 'https://mediso.com/global/hu/career?search=&location=&category=9' },
  { label: 'Thyssenkrupp – állások', url: 'https://jobs.thyssenkrupp.com/hu?filter=jobField%3AIT&location=Hungary%2C+Magyarorsz%C3%A1g&lat=47.1817585&lng=19.5060937&placeId=512e36525b8f8133405990a2cedc43974740f00101f9015753000000000000c0020b92030748756e67617279&radius=0' },
  { label: 'Continental – állások', url: 'https://jobs.continental.com/hu/#/?fieldOfWork_stringS=3a2330f4-2793-4895-b7c7-aee9c965ae22,b99ff13c-96c8-4a72-b427-dec7effd7338&location=%7B%22title%22:%22Magyarorsz%C3%A1g%22,%22type%22:%22country%22,%22countryCode%22:%22hu%22%7D&searchTerm=intern' }
];

function getDomain(u) {
  try { return new URL(u).host.replace(/^www\./, ''); } catch { return ''; }
}

export default function LinksLauncher({ autoOpen = false }) {
  const [warnModal, setWarnModal] = useState(false);

  const openAll = useCallback((links) => {
    links.forEach(({ url }) => {
      window.open(url, '_blank', 'noopener,noreferrer');
    });
  }, []);

  const handleOpenAllClick = useCallback((links) => {
    setWarnModal({ open: true, links }); // tároljuk, melyik listát nyitjuk
  }, []);

  const confirmAndOpen = useCallback(() => {
    setWarnModal({ open: false, links: [] });
    setTimeout(() => openAll(warnModal.links), 50);
  }, [openAll, warnModal]);

  useEffect(() => {
    if (autoOpen) {
      setWarnModal({ open: true, links: [...JOB_PORTALS, ...COMPANIES] });
    }
  }, [autoOpen]);

  const renderLinks = (title, links) => (
    <section className="links-launcher" aria-labelledby={`${title}-title`}>
      <header className="ll-head">
        <div>
          <h2 id={`${title}-title`}>{title}</h2>
        </div>
        <div className="ll-actions">
          <button
            className="btn btn-primary btn-red"
            onClick={() => handleOpenAllClick(links)}
          >
            Összes megnyitása
          </button>
        </div>
      </header>

      <ul className="link-grid">
        {links.map(({ label, url }) => (
          <li key={url} className="link-card">
            <a href={url} target="_blank" rel="noopener noreferrer" className="card-link">
              <div className="card-title">{label}</div>
              <div className="card-meta">
                <span className="dot" />
                <span>{getDomain(url)}</span>
                <span className="ext" aria-hidden="true">↗</span>
              </div>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );

  return (
    <>
      <style>{`
        .links-launcher .link-card .card-meta .dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          display: inline-block;
          background-color: #22c55e !important;
          opacity: 1;
          filter: none;
        }
      `}</style>

      {renderLinks('Munka portálok', JOB_PORTALS)}
      {renderLinks('Cégek', COMPANIES)}

      {warnModal.open && (
        <div className="popup-blocker-overlay" role="dialog" aria-modal="true" aria-labelledby="warn-title">
          <div className="popup-blocker-box">
            <h3 id="warn-title">Felugró ablakok – tipp</h3>
            <p>
              Több lap fog megnyílni. Ha a böngésződ tiltja a felugrókat,
              engedélyezd őket ehhez az oldalhoz, majd folytasd.
            </p>
            <p className="popup-guide">
              <strong>Chrome / Edge:</strong> címsor jobb oldalán a blokkolt ikon → „Felugró ablakok és átirányítások” → Engedélyezés az oldalnál.<br />
              <strong>Firefox:</strong> sáv felül/alul → Engedélyezés.
            </p>
            <div className="popup-actions">
              <button className="btn btn-primary btn-red" onClick={confirmAndOpen}>Folytatás</button>
              <button className="btn btn-ghost" onClick={() => setWarnModal({ open: false, links: [] })}>Mégse</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
