import React, { useEffect, useState, useCallback } from 'react';

const OTHERS_LINKS = [
  { label: 'pauad1 📚', url: 'https://users.itk.ppke.hu/~pauad1/' },
  { label: 'hakkeltamas 🖤', url: 'https://itk.hakkeltamas.hu/' },
  { label: 'ekacs 🦔', url: 'https://users.itk.ppke.hu/~ekacs/anyagok/' },
  { label: 'radzi1 📚', url: 'https://users.itk.ppke.hu/~radzi1/' },
  { label: 'szege7 🧩', url: 'https://users.itk.ppke.hu/~szege7/' },
  { label: 'gyoad5 🕊️', url: 'https://users.itk.ppke.hu/~gyoad5/i_sem/index.html' },
  { label: 'retge1 🍞', url: 'https://users.itk.ppke.hu/~retge1/' },
  { label: 'szama36 📘', url: 'https://users.itk.ppke.hu/~szama36/Hasznos%20dolgok/index.html' },
  { label: 'balma14 📚', url: 'https://users.itk.ppke.hu/~balma14/' },
  { label: 'bolle 📚', url: 'https://users.itk.ppke.hu/~bolle/Minden%20-by%20Bal%c3%a1zs%20M%c3%a1ty%c3%a1s/' },
  { label: 'vagle 🌀', url: 'https://users.itk.ppke.hu/~vagle/main/segedletek' },
  { label: 'hudes ☁️', url: 'https://drive.google.com/drive/folders/1Mcsi-VZUb1PcdKfhHFXn3JHNiRei28BO' },
  { label: 'petma12 📂', url: 'https://users.itk.ppke.hu/~petma12/' },
  { label: 'csobo3 📚', url: 'https://users.itk.ppke.hu/~csobo3/' },
  { label: 'juhki1 📚', url: 'https://users.itk.ppke.hu/~juhki1/jegyzetek/' },
  { label: 'nagda9 🔵', url: 'https://users.itk.ppke.hu/~nagda9/home.php' },
  { label: 'szale8 📗', url: 'https://users.itk.ppke.hu/~szale8' },
  { label: 'heihe 🌲', url: 'https://users.itk.ppke.hu/~heihe/' },
  { label: 'morak 🛰️', url: 'https://users.itk.ppke.hu/~morak/' },
  { label: 'vecha ☁️', url: 'https://mega.nz/folder/kYEiST5A#tdOn3s5WDauUS1mkhUAgDQ' },
  { label: 'mozbo 🐈', url: 'https://users.itk.ppke.hu/~mozbo/' },
  { label: 'PPKE WIKI 🅦', url: 'https://users.itk.ppke.hu/~marri1/' },
];

const ADDITIONAL_LINKS = {
  'Kevesebb anyag - 2025.08': [
    { label: 'araba4', url: 'https://users.itk.ppke.hu/~araba4/' },
    { label: 'perpa4', url: 'https://users.itk.ppke.hu/~perpa4' },
    { label: 'szumi3', url: 'https://users.itk.ppke.hu/~szumi3/' },
    { label: 'nemda3', url: 'https://users.itk.ppke.hu/~nemda3/' },
    { label: 'erdar2', url: 'https://users.itk.ppke.hu/~erdar2' },
    { label: 'nemda2', url: 'https://users.itk.ppke.hu/~nemda2/' },
    { label: 'szaba30', url: 'https://users.itk.ppke.hu/~szaba30/' },
    { label: 'bocka2', url: 'https://users.itk.ppke.hu/~bocka2/' },
    { label: 'szama50', url: 'https://users.itk.ppke.hu/~szama50/' },
    { label: 'nadak', url: 'https://users.itk.ppke.hu/~nadak/#/f' },
    { label: 'fedad', url: 'https://users.itk.ppke.hu/~fedad/' },
    { label: 'kisbe32', url: 'https://users.itk.ppke.hu/~kisbe32/' },
    { label: 'misma', url: 'https://users.itk.ppke.hu/~misma/public_html_2/vsz_2020_vids.php' },
    { label: 'pocta', url: 'https://users.itk.ppke.hu/~pocta/' },
    { label: 'cseda6', url: 'https://users.itk.ppke.hu/~cseda6/public_html/files/' },
    { label: 'tarcs', url: 'https://users.itk.ppke.hu/~tarcs/' },
    { label: 'odobo', url: 'https://users.itk.ppke.hu/~odobo/' },
  ],
  'Folyamatban - 2025.08': [
    { label: 'vasbo2', url: 'https://users.itk.ppke.hu/~vasbo2' },
    { label: 'tabcs', url: 'https://users.itk.ppke.hu/~tabcs/' },
    { label: 'lazta3', url: 'https://users.itk.ppke.hu/~lazta3/' },
    { label: 'herpe3', url: 'https://users.itk.ppke.hu/~herpe3/' },
    { label: 'skulo', url: 'https://users.itk.ppke.hu/~skulo/web/index.html' },
    { label: 'kadso', url: 'https://users.itk.ppke.hu/~kadso/' },
    { label: 'orbsa2', url: 'https://users.itk.ppke.hu/~orbsa2/' },
  ],
  'GAME :': [
    { label: 'gelge1', url: 'https://users.itk.ppke.hu/~gelge1/' },
    { label: 'wagzi', url: 'https://users.itk.ppke.hu/~wagzi/G7V/' },
  ],
  'Random WTF :': [
    { label: 'juhki1', url: 'https://users.itk.ppke.hu/~juhki1/' },
    { label: 'juhga7', url: 'https://users.itk.ppke.hu/~juhga7/Jegyzetek/Honlap/galeria1.html' },
    { label: 'prabo', url: 'https://users.itk.ppke.hu/~prabo/' },
    { label: 'kovzo14', url: 'https://users.itk.ppke.hu/~kovzo14' },
    { label: 'juhbe8', url: 'https://users.itk.ppke.hu/~juhbe8/' },
    { label: 'szeem4', url: 'https://users.itk.ppke.hu/~szeem4' },
    { label: 'berbo5', url: 'https://users.itk.ppke.hu/~berbo5' },
    { label: 'kolcs', url: 'https://users.itk.ppke.hu/~kolcs' },
    { label: 'totbe31', url: 'https://users.itk.ppke.hu/~totbe31' },
    { label: 'tolma1', url: 'https://users.itk.ppke.hu/~tolma1/' },
    { label: 'fabal3', url: 'https://users.itk.ppke.hu/~fabal3/' },
    { label: 'hugal', url: 'https://users.itk.ppke.hu/~hugal/' },
    { label: 'mulkr', url: 'https://users.itk.ppke.hu/~mulkr/' },
    { label: 'sikbo', url: 'https://users.itk.ppke.hu/~sikbo/' },
    { label: 'kovri7', url: 'https://users.itk.ppke.hu/~kovri7/' },
  ],
};

function getDomain(u) {
  try { return new URL(u).host.replace(/^www\./, ''); } catch { return ''; }
}

export default function OthersLinksStyled({ autoOpen = false }) {
  const [warn, setWarn] = useState({ open: false, links: [] });
  const [moreOpen, setMoreOpen] = useState(false); // fallback modal, ha a popup-ot blokkolja a böngésző

  const openAll = useCallback((links) => {
    links.forEach(({ url }) => window.open(url, '_blank', 'noopener,noreferrer'));
  }, []);

  const askAndOpenAll = useCallback((links) => setWarn({ open: true, links }), []);

  const confirmAndOpen = useCallback(() => {
    setWarn((prev) => {
      const l = prev.links;
      setTimeout(() => openAll(l), 50);
      return { open: false, links: [] };
    });
  }, [openAll]);

  useEffect(() => {
    if (autoOpen) setWarn({ open: true, links: [...OTHERS_LINKS] });
  }, [autoOpen]);

  // --- UI helpers ---
  const Section = ({ title, links, extra }) => (
    <section className="others-ll__section" aria-labelledby={`${title}-title`}>
      <header className="others-ll__head">
        <h2 id={`${title}-title`}>{title}</h2>
        <div className="others-ll__actions">
          <button className="others-ll__btn btn-red" onClick={() => askAndOpenAll(links)}>
            Összes megnyitása
          </button>
          {extra}
        </div>
      </header>

      <ul className="others-ll__grid">
        {links.map(({ label, url }) => (
          <li key={url} className="others-ll__card">
            <a href={url} target="_blank" rel="noopener noreferrer" className="others-ll__cardLink">
              <div className="others-ll__title" title={label}>{label}</div>
              <div className="others-ll__meta">
                <span className="others-ll__dot" />
                <span>{getDomain(url)}</span>
                <span className="others-ll__ext" aria-hidden>↗</span>
              </div>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );

  const allAdditional = Object.values(ADDITIONAL_LINKS).flat();


  return (
    <div className="others-ll">
      {/* Szigorúan scope-olt stílusok, hogy a formázás ne "folyjon szét" */}
      <style>{`
        .others-ll, .others-ll * { box-sizing: border-box; }
        .others-ll { position: relative; isolation: isolate;
          --ll-bg: rgba(20,20,20,0.65);
          --ll-card: rgba(255,255,255,0.06);
          --ll-card-hover: rgba(255,255,255,0.12);
          --ll-border: rgba(255,255,255,0.12);
          --ll-text: #f4f4f5;
          --ll-muted: #c9c9ce;
          --ll-shadow: 0 10px 30px rgba(0,0,0,.35);
          --ll-radius: 16px;
          --ll-blur: saturate(140%) blur(6px);
        }
        .others-ll__container { max-width: 1240px; margin: 0 auto; padding: 12px 16px 24px; padding-left: 120px; }
        .others-ll__section { margin: 18px 0 26px; color: var(--ll-text); background: var(--ll-bg); backdrop-filter: var(--ll-blur); border: 1px solid var(--ll-border); border-radius: var(--ll-radius); padding: 18px 18px 22px; box-shadow: var(--ll-shadow); }
        .others-ll__head{ display:flex; align-items:flex-end; justify-content:space-between; gap:12px; margin-bottom:14px; border-bottom:1px solid var(--ll-border); padding-bottom:12px; }
        .others-ll__head h2{ margin:0; font-size: clamp(20px, 2.4vw, 28px); letter-spacing:.2px; }
        .others-ll__actions{ display:flex; gap:10px; flex-wrap:wrap; }
        .others-ll__btn{ border-radius:12px; padding:10px 14px; border:1px solid var(--ll-border); background: var(--ll-card); color: var(--ll-text); cursor: pointer; display:inline-flex; align-items:center; gap:8px; }
        .others-ll__btn:hover{ background: var(--ll-card-hover); }
        .others-ll__btn:active{ background: var(--ll-card-hover); }
        .others-ll__btn--ghost{ background: transparent; }
        .btn-red{ background-color:#e53935 !important; border-color:#e53935 !important; color:#fff !important; }
        .btn-red:hover{ background-color:#c62828 !important; border-color:#c62828 !important; }
        .others-ll__grid{ list-style:none; margin:12px 0 0; padding:0; display:grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; align-items: stretch; }
        .others-ll__card{ border-radius: var(--ll-radius); overflow: clip; border: 1px solid var(--ll-border); background: linear-gradient(180deg, var(--ll-card), rgba(255,255,255,0.03)); box-shadow: var(--ll-shadow); }
        .others-ll__card:hover{ border-color: rgba(255,255,255,.22); }
        .others-ll__cardLink{ display:block; padding:14px 14px 12px; text-decoration:none; color:inherit; min-height: 96px; }
        .others-ll__title{ font-weight:600; line-height:1.2; margin-bottom:8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .others-ll__meta{ display:flex; align-items:center; gap:8px; font-size:.9rem; color: var(--ll-muted); }
        .others-ll__dot{ width:6px; height:6px; border-radius:999px; background: var(--ll-muted); opacity:.6; }
        .others-ll__ext{ margin-left:auto; opacity:.7; }
        @media (max-width: 520px){ .others-ll__section{ padding:5px; border-radius:14px; } }
        @media (max-width: 844px){ .others-ll__container{ padding-left:0 !important; } }
        @media (max-width: 768px) {
          .others-ll__container { padding: 8px 10px 18px; }
          .others-ll__head { flex-direction: column; align-items: stretch; gap:10px; }
          .others-ll__actions { justify-content: flex-start; }
          .others-ll__btn { width: 100%; }
          .others-ll__grid { grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 10px; }
          .others-ll__cardLink { min-height: 92px; }
        }
      `}</style>

      <div className="others-ll__container">
        {/* Fő szekció, felül a További linkek gombbal */}
        <Section
          title="Alap linkek"
          links={OTHERS_LINKS}
          extra={<button className="others-ll__btn others-ll__btn--ghost" onClick={() => setMoreOpen(true)}>További linkek</button>}        />
      </div>

      {/* Fallback: További linkek MODAL (ha a popup blokkolva van) */}
      {moreOpen && (
        <div className="others-ll__overlay" role="dialog" aria-modal="true" aria-labelledby="more-title" onClick={() => setMoreOpen(false)}>
          <div className="others-ll__modal" onClick={(e) => e.stopPropagation()}>
            <div className="others-ll__modalHead">
              <h3 id="more-title" style={{ margin: 0 }}>További linkek</h3>
              <div style={{ display:'flex', gap:8, alignItems:'center' }}>
                <button className="others-ll__btn btn-red" onClick={() => askAndOpenAll(allAdditional)}>Összes megnyitása</button>
                <button className="others-ll__btn others-ll__btn--ghost" onClick={() => setMoreOpen(false)} aria-label="Bezárás">&times;</button>
              </div>
            </div>

            {Object.entries(ADDITIONAL_LINKS).map(([category, links]) => (
              <section key={category} className="others-ll__section" aria-labelledby={`sec-${category}`}>
                <header className="others-ll__head">
                  <h2 id={`sec-${category}`}>{category}</h2>
                  <div className="others-ll__actions">
                    <button className="others-ll__btn btn-red" onClick={() => askAndOpenAll(links)}>Összes megnyitása</button>
                  </div>
                </header>
                <ul className="others-ll__grid">
                  {links.map(({ label, url }) => (
                    <li key={url} className="others-ll__card">
                      <a className="others-ll__cardLink" href={url} target="_blank" rel="noopener noreferrer">
                        <div className="others-ll__title" title={label}>{label}</div>
                        <div className="others-ll__meta">
                          <span className="others-ll__dot" />
                          <span>{getDomain(url)}</span>
                          <span className="others-ll__ext" aria-hidden>↗</span>
                        </div>
                      </a>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </div>
      )}

      {/* Felugró blokkoló figyelmeztetés a tömeges nyitásnál */}
      {warn.open && (
        <div className="others-ll__pbOverlay" role="dialog" aria-modal="true" aria-labelledby="warn-title">
          <div className="others-ll__modal others-ll__pbBox">
            <h3 id="warn-title" style={{ marginTop: 0 }}>Felugró ablakok – tipp</h3>
            <p>Több lap fog megnyílni. Ha a böngésződ tiltja a felugrókat, engedélyezd őket ehhez az oldalhoz, majd folytasd.</p>
            <p className="others-ll__guide">
              <strong>Chrome / Edge:</strong> címsor jobb oldalán a blokkolt ikon → „Felugró ablakok és átirányítások” → Engedélyezés az oldalnál.<br />
              <strong>Firefox:</strong> sáv felül/alul → Engedélyezés.
            </p>
            <div className="others-ll__pbActions">
              <button className="others-ll__btn btn-red" onClick={confirmAndOpen}>Folytatás</button>
              <button className="others-ll__btn others-ll__btn--ghost" onClick={() => setWarn({ open: false, links: [] })}>Mégse</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
