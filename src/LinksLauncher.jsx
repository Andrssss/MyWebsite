import React, { useEffect, useState, useCallback } from 'react';

const LINKS = [
  { label: 'Melódiák – gyakornoki/szakmai', url: 'https://www.melodiak.hu/diakmunkak/?l=gyakornoki-szakmai-munkak' },
  { label: 'Minddiák ', url: 'https://minddiak.hu/position?page=2' },
  { label: 'Muisz – gyakornoki kategória', url: 'https://muisz.hu/hu/diakmunkaink?categories=3' },
  { label: 'CV Centrum – gyakornok IT', url: 'https://cvcentrum.hu/allasok/?s=gyakornok&category%5B%5D=it&category%5B%5D=it-programozas&category%5B%5D=it-uzemeltetes' },
  { label: 'Zyntern – IT/fejlesztés', url: 'https://zyntern.com/jobs?fields=16' },
  { label: 'OTP Karrier – GYAKORNOK keresés', url: 'https://karrier.otpbank.hu/go/Minden-allasajanlat/1167001/?q=&q2=&alertId=&locationsearch=&title=GYAKORNOK&date=&location=&shifttype=' },
  { label: 'Profession – IT fejlesztés (intern)', url: 'https://www.profession.hu/allasok/it-programozas-fejlesztes/1,10,0,intern' },
  { label: 'Profession – (gyakornok)', url: 'https://www.profession.hu/allasok/1,0,0,gyakornok%401%401?keywordsearch' },
  { label: 'Fürge Diák – gyakornok', url: 'https://gyakornok.furgediak.hu/allasok?statikusmunkakor=7' },
  { label: 'Schönherz – Budapest fejlesztő/tesztelő', url: 'https://schonherz.hu/diakmunkak/budapest/fejleszto---tesztelo' },
];

function getDomain(u) {
  try { return new URL(u).host.replace(/^www\./, ''); } catch { return ''; }
}

export default function LinksLauncher({ autoOpen = false }) {
  const [warnModal, setWarnModal] = useState(false);

  const openAll = useCallback(() => {
    LINKS.forEach(({ url }) => {
      window.open(url, '_blank', 'noopener,noreferrer');
    });
  }, []);

  const handleOpenAllClick = useCallback(() => {
    setWarnModal(true); // mindig figyelmeztetés előbb
  }, []);

  const confirmAndOpen = useCallback(() => {
    setWarnModal(false);
    setTimeout(openAll, 50); // kis késleltetés a modal bezárása után
  }, [openAll]);

  useEffect(() => {
    if (autoOpen) {
      setWarnModal(true); // auto módban is először csak figyelmeztetés
    }
  }, [autoOpen]);

  return (
    <section className="links-launcher" aria-labelledby="re-title">
      <style>{`
        .links-launcher .link-card .card-meta .dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          display: inline-block;
          background-color: #22c55e !important; /* zöld */
          opacity: 1;
          filter: none;
        }
      `}</style>
      <header className="ll-head">
        <div>
          <h2 id="re-title">Gyakornoki / IT linkek</h2>
          <p className="ll-sub">Összegyűjtött releváns állás/gyakornoki oldalak. Ezek a linkeket érdemes heti párszor megnézegetni.</p>
        </div>
        <div className="ll-actions">
          <button className="btn btn-primary btn-red" onClick={handleOpenAllClick}>
            Összes megnyitása
          </button>
        </div>
      </header>

      <ul className="link-grid">
        {LINKS.map(({ label, url }) => (
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

      {/* Figyelmeztető modal minden esetben */}
      {warnModal && (
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
              <button className="btn btn-ghost" onClick={() => setWarnModal(false)}>Mégse</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}


