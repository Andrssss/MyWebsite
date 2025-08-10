import React, { useEffect, useState, useCallback } from 'react';

const LINKS = [
  { label: 'Melódiák – gyakornoki/szakmai', url: 'https://www.melodiak.hu/diakmunkak/?l=gyakornoki-szakmai-munkak' },
  { label: 'Minddiák (page=2)', url: 'https://minddiak.hu/position?page=2' },
  { label: 'Muisz – gyakornoki kategória', url: 'https://muisz.hu/hu/diakmunkaink?categories=3' },
  { label: 'CV Centrum – gyakornok IT', url: 'https://cvcentrum.hu/allasok/?s=gyakornok&category%5B%5D=it&category%5B%5D=it-programozas&category%5B%5D=it-uzemeltetes' },
  { label: 'Zyntern – IT/fejlesztés', url: 'https://zyntern.com/jobs?fields=16' },
  { label: 'OTP Karrier – GYAKORNOK keresés', url: 'https://karrier.otpbank.hu/go/Minden-allasajanlat/1167001/?q=&q2=&alertId=&locationsearch=&title=GYAKORNOK&date=&location=&shifttype=' },
  { label: 'Profession – IT fejlesztés (intern)', url: 'https://www.profession.hu/allasok/it-programozas-fejlesztes/1,10,0,intern' },
  { label: 'Profession – Somogy (gyakornok)', url: 'https://www.profession.hu/allasok/somogy/1,0,38,gyakornok%401%401?keywordsearch' },
  { label: 'Fürge Diák – gyakornok', url: 'https://gyakornok.furgediak.hu/allasok?statikusmunkakor=7' },
  { label: 'Schönherz – Budapest fejlesztő/tesztelő', url: 'https://schonherz.hu/diakmunkak/budapest/fejleszto---tesztelo' },
];

function getDomain(u) {
  try { return new URL(u).host.replace(/^www\./, ''); } catch { return ''; }
}

export default function LinksLauncher({ autoOpen = false }) {
  const [status, setStatus] = useState('');

  const openAll = useCallback(() => {
    let opened = 0;
    LINKS.forEach(({ url }) => {
      const w = window.open(url, '_blank', 'noopener,noreferrer');
      if (w) opened++;
    });

    if (opened === LINKS.length) {
      setStatus('Minden link megnyitva új lapokon.');
    } else if (opened === 0) {
      setStatus('A böngésző popup-blokkolója letiltotta.');
    } else {
      setStatus(`Csak ${opened}/${LINKS.length} nyílt meg (popup-blokkoló?).`);
    }
  }, []);

  // AUTO mód: betöltéskor egyből nyissa
  useEffect(() => {
    if (autoOpen) {
      const t = setTimeout(openAll, 100);
      return () => clearTimeout(t);
    }
  }, [autoOpen, openAll]);

  return (
    <section className="links-launcher" aria-labelledby="re-title">
      <header className="ll-head">
        <div>
          <h2 id="re-title">Gyakornoki / IT linkek</h2>
          <p className="ll-sub">Összegyűjtött releváns állás/gyakornoki oldalak.</p>
        </div>

        <div className="ll-actions">
          <button className="btn btn-primary btn-red" onClick={openAll}>
            Összes megnyitása
          </button>
        </div>
      </header>

      {status && <div className="ll-status" role="status">{status}</div>}

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
    </section>
  );
}
